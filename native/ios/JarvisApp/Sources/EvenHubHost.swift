import Foundation
import G2Kit
import WebKit

/// What our page currently shows on the lenses (kept so it can be replayed after a reconnect and
/// drawn in the in-app lens preview).
@MainActor
final class LensMirror: ObservableObject {
    @Published var page: PageSpec?
    @Published var selected: [Int: Int] = [:]
    @Published var micOpen = false
    @Published var micSource = ""

    func setText(_ id: Int, _ content: String) {
        guard var p = page, let i = p.text.firstIndex(where: { $0.id == id }) else { return }
        p.text[i].content = content
        page = p
    }
}

/// Plays the Even App's role for the glasses web app: emulates `window.flutter_inappwebview`, so the
/// unmodified Even Hub SDK in `glasses/` finds a host, and maps every SDK call to the Swift driver.
///
/// SDK -> host: `flutter_inappwebview.callHandler('evenAppMessage', '{"type":"call_even_app_method","method":…,"data":…}')`,
///              awaited for its return value (WKScriptMessageHandlerWithReply resolves the JS promise).
/// host -> SDK: `window._listenEvenAppMessage({type:'listen_even_app_data', method:'evenHubEvent'|'appLocationChanged'|
///              'deviceStatusChanged', data:{type:'sysEvent', jsonData:{…}}})`.
/// Both envelopes were confirmed by running SDK 0.0.16 against a stub host (see README).
@MainActor
final class EvenHubHost: NSObject, WKScriptMessageHandlerWithReply, WKScriptMessageHandler {
    static let handlerName = "jarvisHost"
    static let logHandlerName = "jarvisLog"

    weak var webView: WKWebView?
    let mirror = LensMirror()
    private let settings: AppSettings
    private let glasses: GlassesLink
    private let location = LocationProvider()
    private let phoneMic = PhoneMic()
    private var stopGlassesMic: (() -> Void)?
    private var locationUpdates = false

    init(settings: AppSettings, glasses: GlassesLink) {
        self.settings = settings
        self.glasses = glasses
        super.init()
        glasses.onInput = { [weak self] e in self?.forwardInput(e) }
        glasses.onAudio = { [weak self] pcm in self?.pushAudio(pcm, source: "glasses") }
        glasses.onSession = { [weak self] drv in self?.replay(on: drv) }
        glasses.onDevice = { [weak self] info in self?.pushDeviceStatus(info) }
        glasses.onPageClosed = { [weak self] in
            self?.mirror.micOpen = false
            log("the glasses closed our page; it is re-created on the next update")
        }
        phoneMic.onPCM = { [weak self] pcm in self?.pushAudio(pcm, source: "phone") }
        location.onUpdate = { [weak self] loc in
            guard let self, self.locationUpdates else { return }
            self.push("appLocationChanged", loc)
        }
    }

    // MARK: injected script

    static let userScript = """
    (function () {
      if (window.flutter_inappwebview) return;
      var host = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName);
      if (!host) return;
      window.flutter_inappwebview = {
        callHandler: function (name) {
          var args = Array.prototype.slice.call(arguments, 1);
          return host.postMessage({ handler: name, args: args });
        }
      };
      window.__jarvisNativeHost = true;
      // glasses/src/core.ts sendImage: images as base64 BMP through callHandler('jarvisImage', {...}).
      window.__jarvisImageHost = 1;
      var logHost = window.webkit.messageHandlers.\(logHandlerName);
      ['log', 'warn', 'error'].forEach(function (level) {
        var orig = console[level];
        console[level] = function () {
          try {
            logHost.postMessage(level + ': ' + Array.prototype.map.call(arguments, function (a) {
              if (typeof a === 'string') return a;
              try { return JSON.stringify(a); } catch (e) { return String(a); }
            }).join(' ').slice(0, 500));
          } catch (e) {}
          return orig.apply(console, arguments);
        };
      });
      window.addEventListener('error', function (e) { logHost.postMessage('page error: ' + e.message); });
    })();
    """

    // MARK: WKScriptMessageHandler (console)

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            let text = message.body as? String ?? "\(message.body)"
            // The SDK logs every EvenHub event; mic audio arrives 10+ times a second, so skip those.
            if text.contains("\"audioPcm\"") { return }
            log("page \(text)")
        }
    }

    // MARK: WKScriptMessageHandlerWithReply (SDK calls)

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                           replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, isHubPage(scheme: origin.protocol, host: origin.host, port: origin.port) else {
                log("SDK call refused: \(origin.protocol)://\(origin.host) is not the hub page")
                return replyHandler(nil, "not the hub page")
            }
            let body = message.body
            guard let dict = body as? [String: Any], let args = dict["args"] as? [Any], let first = args.first else {
                return replyHandler(nil, "bad message")
            }
            if dict["handler"] as? String == "jarvisImage", let req = first as? [String: Any] {
                let received = Date()
                Task { @MainActor in replyHandler(await self.nativeImage(req, received: received), nil) }
                return
            }
            var envelope: [String: Any]?
            if let s = first as? String, let data = s.data(using: .utf8) {
                envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            } else {
                envelope = first as? [String: Any]
            }
            guard let env = envelope, let method = env["method"] as? String else { return replyHandler(nil, "no method") }
            let data = env["data"] as? [String: Any] ?? [:]
            Task { @MainActor in
                let result = await self.call(method, data)
                replyHandler(result ?? NSNull(), nil)
            }
        }
    }

    // MARK: SDK methods

    private func call(_ method: String, _ data: [String: Any]) async -> Any? {
        switch method {
        case "createStartUpPageContainer":
            guard let spec = SDKModels.page(from: data) else { return 1 }
            if let e = validate(spec) { log("createStartUpPageContainer rejected: \(e)"); return 1 }
            imageLog.pageChanged()
            mirror.page = spec
            mirror.selected = [:]
            await draw(spec, rebuild: false)
            return 0 // StartUpPageCreateResult.success
        case "rebuildPageContainer":
            guard let spec = SDKModels.page(from: data) else { return false }
            if let e = validate(spec) { log("rebuildPageContainer rejected: \(e)"); return false }
            imageLog.pageChanged()
            mirror.page = spec
            mirror.selected = [:]
            return await draw(spec, rebuild: true)
        case "textContainerUpgrade":
            guard let id = SDKModels.int(data, "containerID", "Container_ID") else { return false }
            let content = SDKModels.string(data, "content", "Content") ?? " "
            mirror.setText(id, content)
            guard let drv = glasses.driver else { return true }
            if !drv.pageAlive, let page = mirror.page { return await draw(page, rebuild: true) }
            do { try await drv.setText(id, content) } catch { log("text \(id): \(error)"); return false }
            return true
        case "updateImageRawData":
            return await updateImage(data)
        case "audioControl":
            return await audioControl(open: data["isOpen"] as? Bool ?? false, source: data["source"] as? String ?? "glasses")
        case "imuControl":
            guard let drv = glasses.driver else { return false }
            let on = (SDKModels.int(data, "iMUReportEn", "IMU_ReportEn") ?? 0) != 0
            do { try await drv.setImu(on, reportFrq: SDKModels.int(data, "reportFrq") ?? 100) } catch { return false }
            return true
        case "shutDownPageContainer":
            mirror.page = nil
            guard let drv = glasses.driver else { return true }
            do { try await drv.shutdown(exitMode: SDKModels.int(data, "exitMode") ?? 0) } catch { return false }
            return true
        case "getLocalStorage":
            return settings.pageValue(data["key"] as? String ?? "")
        case "setLocalStorage":
            settings.setPageValue(data["key"] as? String ?? "", data["value"] as? String ?? "")
            return true
        case "getAppLocation":
            let timeout = Double(SDKModels.int(data, "timeoutMs") ?? 8000) / 1000
            return await location.currentFix(timeout: timeout) ?? NSNull()
        case "startAppLocationUpdates":
            locationUpdates = true
            location.start(distanceFilter: Double(SDKModels.int(data, "distanceFilter") ?? 5))
            return true
        case "stopAppLocationUpdates":
            locationUpdates = false
            location.stop()
            return true
        case "getUserInfo":
            return ["uid": 0, "name": "Jarvis", "avatar": "", "country": ""]
        case "getGlassesInfo", "getDeviceInfo":
            return deviceInfoJSON()
        default:
            log("unsupported SDK call \(method)")
            return nil
        }
    }

    private func validate(_ spec: PageSpec) -> String? {
        do { try EvenHub.validatePage(spec); return nil } catch { return "\(error)" }
    }

    /// Send a page to the lenses (if connected). Returns false only when the glasses refused the write.
    @discardableResult
    private func draw(_ spec: PageSpec, rebuild: Bool) async -> Bool {
        guard let drv = glasses.driver else { return true }
        do {
            if rebuild { try await drv.rebuildPage(spec) } else { try await drv.createPage(spec) }
            return true
        } catch {
            log("page: \(error)")
            return false
        }
    }

    /// New BLE session: put the current page back on the lenses.
    private func replay(on drv: G2Driver) {
        guard let page = mirror.page else { return }
        Task { @MainActor in
            do { try await drv.createPage(page) } catch { log("replay page: \(error)") }
        }
    }

    /// Re-send what the page last drew (button on the Glasses tab).
    func redraw() {
        guard let page = mirror.page else { return log("no page yet: is the Jarvis page loaded?") }
        Task { await draw(page, rebuild: true) }
    }

    /// The SDK's updateImageRawData: PNG/JPEG (or BMP) bytes as a number array or base64.
    private func updateImage(_ data: [String: Any]) async -> String {
        let started = Date()
        guard let id = SDKModels.int(data, "containerID", "Container_ID") else { return "imageException" }
        let name = SDKModels.string(data, "containerName", "Container_Name")
        guard let bytes = SDKModels.bytes(data["imageData"] ?? data["Image_Data"]) else { return "imageException" }
        let box = mirror.page?.image.first { $0.id == id }
        guard let bmp = ImageConvert.bmp4(from: bytes, width: box?.width, height: box?.height) else { return "imageToGray4Failed" }
        var t = ImageTiming(name: name ?? "image \(id)", width: box?.width, height: box?.height, bmpBytes: bmp.count, path: "sdk")
        t.inBytes = bytes.count
        t.decodeMs = ms(since: started)
        return await sendImage(id, name: name, bmp: bmp, timing: t, started: started, format: nil)
    }

    /// glasses/src/core.ts sendImage: `{containerID, containerName, bmp: base64 BMP, sentAt: epoch ms, encodeMs, format?}`.
    /// `format` (LENS TEST) forces that payload for this push, bypassing the session fallback.
    private func nativeImage(_ req: [String: Any], received: Date) async -> String {
        guard let id = SDKModels.int(req, "containerID"), let b64 = req["bmp"] as? String,
              let data = Data(base64Encoded: b64) else { return "imageException" }
        let name = SDKModels.string(req, "containerName")
        let box = mirror.page?.image.first { $0.id == id }
        guard let bmp = ImageConvert.bmp4(from: [UInt8](data), width: box?.width, height: box?.height) else { return "imageToGray4Failed" }
        var t = ImageTiming(name: name ?? "image \(id)", width: box?.width, height: box?.height, bmpBytes: bmp.count, path: "native")
        t.encodeMs = (req["encodeMs"] as? NSNumber)?.intValue
        if let sentAt = (req["sentAt"] as? NSNumber)?.doubleValue {
            t.bridgeMs = max(0, Int(received.timeIntervalSince1970 * 1000 - sentAt))
        }
        t.decodeMs = ms(since: received)
        let forced = (req["format"] as? String).flatMap(ImageFormat.init(rawValue:))
        return await sendImage(id, name: name, bmp: bmp, timing: t, started: received, format: forced)
    }

    /// `format` nil = the Settings choice (with the session fallback); set = forced (LENS TEST).
    private func sendImage(_ id: Int, name: String?, bmp: [UInt8], timing: ImageTiming, started: Date, format: ImageFormat?) async -> String {
        var t = timing
        guard let drv = glasses.driver else {
            t.result = "no glasses"
            imageLog.add(t)
            return "success"
        }
        var result = "sendFailed"
        do {
            let chosen = format ?? ImageFormat(rawValue: settings.imageFormat) ?? .standard
            result = try await drv.setImage(id, bmp: bmp, containerName: name, format: chosen, force: format != nil) ? "success" : "sendFailed"
        } catch {
            t.error = describeBleError(error)
        }
        t.ble = drv.lastImage
        t.totalMs = ms(since: started)
        t.result = result
        imageLog.add(t)
        return result
    }

    private let imageLog = ImageLog()

    private func audioControl(open: Bool, source: String) async -> Bool {
        if !open {
            stopGlassesMic?()
            stopGlassesMic = nil
            phoneMic.stop()
            if let drv = glasses.driver, drv.micOn { try? await drv.stopMic() }
            mirror.micOpen = false
            return true
        }
        if source != "phone", let drv = glasses.driver {
            do {
                // The mic only runs while our page is up (MentraOS rebuilds the page first).
                if !drv.pageAlive, let page = mirror.page { try await drv.rebuildPage(page) }
                try await drv.startMic()
                mirror.micOpen = true
                mirror.micSource = "glasses"
                return true
            } catch {
                log("mic: \(error)")
                return false
            }
        }
        guard source == "phone" || settings.phoneMicFallback else { return false }
        let ok = await phoneMic.start()
        mirror.micOpen = ok
        mirror.micSource = ok ? "phone" : ""
        if !ok { log("phone mic unavailable") }
        return ok
    }

    /// Whether a page origin is the hub's (the URL we load). The bridge hands out the hub token
    /// (getLocalStorage "hubToken"), drives the glasses and streams the mic, so a page the web view
    /// navigated to elsewhere (a link, a mini-app redirect) gets none of it.
    private func isHubPage(scheme: String?, host: String?, port: Int?) -> Bool {
        guard let hub = settings.glassesPageURL, let s = hub.scheme?.lowercased(), s == "http" || s == "https",
              let h = hub.host?.lowercased() else { return false }
        func effective(_ p: Int?) -> Int { p.flatMap { $0 == 0 ? nil : $0 } ?? (s == "https" ? 443 : 80) }
        return scheme?.lowercased() == s && host?.lowercased() == h && effective(port) == effective(hub.port)
    }

    // MARK: host -> page

    private func push(_ method: String, _ data: Any) {
        guard let url = webView?.url, isHubPage(scheme: url.scheme, host: url.host, port: url.port) else { return }
        let msg: [String: Any] = ["type": "listen_even_app_data", "method": method, "data": data]
        guard let json = try? JSONSerialization.data(withJSONObject: msg), var s = String(data: json, encoding: .utf8) else { return }
        s = s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        webView?.evaluateJavaScript("window._listenEvenAppMessage && window._listenEvenAppMessage(\(s));", completionHandler: nil)
    }

    private func pushHubEvent(_ type: String, _ json: [String: Any]) {
        push("evenHubEvent", ["type": type, "jsonData": json])
    }

    private func forwardInput(_ e: InputEvent) {
        var j: [String: Any] = [:]
        if let t = e.gesture.sdkEventType { j["eventType"] = t } // the SDK reports CLICK as undefined
        switch e.via {
        case .list:
            if let v = e.containerId { j["containerID"] = v }
            if let v = e.containerName { j["containerName"] = v }
            if let v = e.itemIndex { j["currentSelectItemIndex"] = v }
            if let v = e.itemName { j["currentSelectItemName"] = v }
            if let id = e.containerId, let i = e.itemIndex { mirror.selected[id] = i }
            pushHubEvent("listEvent", j)
        case .text:
            if let v = e.containerId { j["containerID"] = v }
            if let v = e.containerName { j["containerName"] = v }
            pushHubEvent("textEvent", j)
        case .sys:
            j["eventSource"] = e.source.sdkCode
            pushHubEvent("sysEvent", j)
        }
        log("input \(e.gesture.rawValue) from \(e.source.rawValue) via \(e.via.rawValue)")
    }

    /// Lens preview buttons: feed a gesture to the page as if the ring sent it.
    func simulate(_ g: Gesture) {
        guard let page = mirror.page else { return }
        if let list = page.list.first(where: \.captureEvents) {
            var sel = mirror.selected[list.id] ?? 0
            if g == .scrollDown { sel = min(list.items.count - 1, sel + 1) }
            if g == .scrollUp { sel = max(0, sel - 1) }
            mirror.selected[list.id] = sel
            if g == .longPress || g == .longPressRelease {
                forwardInput(InputEvent(gesture: g, source: .ring, via: .sys))
            } else {
                forwardInput(InputEvent(gesture: g, source: .ring, via: .list, containerId: list.id, containerName: list.name,
                                        itemIndex: sel, itemName: list.items.indices.contains(sel) ? list.items[sel] : nil))
            }
        } else {
            forwardInput(InputEvent(gesture: g, source: .ring, via: .sys))
        }
    }

    private func pushAudio(_ pcm: [UInt8], source: String) {
        guard mirror.micOpen else { return }
        pushHubEvent("audioEvent", ["audioPcm": Data(pcm).base64EncodedString(), "source": source])
    }

    private func deviceInfoJSON() -> [String: Any] {
        let serial = glasses.glassesSerial
        var status: [String: Any] = ["sn": serial, "connectType": glasses.connected ? "connected" : "disconnected"]
        if let b = glasses.device.battery { status["batteryLevel"] = b }
        if let c = glasses.device.charging { status["isCharging"] = c }
        return ["model": "g2", "sn": serial, "status": status]
    }

    private func pushDeviceStatus(_ info: DeviceInfo) {
        push("deviceStatusChanged", deviceInfoJSON()["status"] ?? [:])
    }

    /// Called when the page (re)loads: it will create its page again.
    func pageWillLoad() {
        mirror.page = nil
        mirror.micOpen = false
        stopGlassesMic = nil
        phoneMic.stop()
    }
}

// MARK: image timing

private func ms(since d: Date) -> Int { Int(Date().timeIntervalSince(d) * 1000) }

/// One image push, page to glasses ACK.
struct ImageTiming {
    var name: String
    var width: Int?
    var height: Int?
    var bmpBytes: Int
    /// "native" (base64 BMP from the page) or "sdk" (PNG number array through the Even Hub SDK).
    var path: String
    /// SDK path: the PNG/JPEG bytes that crossed the bridge.
    var inBytes: Int?
    /// Page-side BMP + base64 encode (native path).
    var encodeMs: Int?
    /// Page call to Swift receipt (native path; both read the same clock).
    var bridgeMs: Int?
    /// base64 / PNG decode and BMP conversion here.
    var decodeMs = 0
    var ble: ImageStats?
    /// From receipt here to the last ACK.
    var totalMs = 0
    var result = ""
    var error: String?

    var line: String {
        let kb = String(format: "%.1fKB", Double(bmpBytes) / 1000)
        var s = "img: \(name) \(width.map(String.init) ?? "?")x\(height.map(String.init) ?? "?") \(kb) \(path)"
        if let inBytes { s += String(format: " (png %.1fKB)", Double(inBytes) / 1000) }
        if let encodeMs { s += " enc \(encodeMs)ms" }
        if let bridgeMs { s += " bridge \(bridgeMs)ms" }
        s += " decode \(decodeMs)ms"
        if let ble { s += " ble \(ble.totalMs)ms (\(ble.summary))" }
        s += " total \((bridgeMs ?? 0) + (encodeMs ?? 0) + totalMs)ms"
        if result != "success" { s += " → \(result)" }
        if let error { s += " (\(error))" }
        return s
    }
}

/// Rate-limited image log: every push right after a page create/rebuild, slow or failed ones, and
/// otherwise one line per 2 s that also summarises the pushes it skipped.
@MainActor
final class ImageLog {
    private var lastLine = Date.distantPast
    private var burst = 4
    private var skipped = 0
    private var skippedTotal = 0
    private var skippedMax = 0

    func pageChanged() { burst = 4 }

    func add(_ t: ImageTiming) {
        let total = (t.bridgeMs ?? 0) + (t.encodeMs ?? 0) + t.totalMs
        let now = Date()
        guard burst > 0 || t.result != "success" || total > 1500 || now.timeIntervalSince(lastLine) >= 2 else {
            skipped += 1
            skippedTotal += total
            skippedMax = max(skippedMax, total)
            return
        }
        if burst > 0 { burst -= 1 }
        var line = t.line
        if skipped > 0 {
            line += " [+\(skipped) more since the last line: avg \(skippedTotal / skipped)ms max \(skippedMax)ms]"
            skipped = 0; skippedTotal = 0; skippedMax = 0
        }
        lastLine = now
        log(line)
    }
}
