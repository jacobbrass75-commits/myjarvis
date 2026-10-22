import G2Kit
import SwiftUI
import UIKit
import WebKit

struct RootView: View {
    // `-startTab 1` as a launch argument opens the Jarvis tab (handy with `simctl launch`).
    @State private var tab = UserDefaults.standard.integer(forKey: "startTab")

    var body: some View {
        TabView(selection: $tab) {
            ConnectView().tabItem { Label("Glasses", systemImage: "eyeglasses") }.tag(0)
            JarvisView().tabItem { Label("Jarvis", systemImage: "rectangle.on.rectangle") }.tag(1)
            HubPageView(title: "Studio", path: "/studio.html").tabItem { Label("Studio", systemImage: "wand.and.stars") }.tag(4)
            HubPageView(title: "Agents", path: "/").tabItem { Label("Agents", systemImage: "person.3.sequence") }.tag(5)
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag(2)
            LogView().tabItem { Label("Log", systemImage: "list.bullet.rectangle") }.tag(3)
        }
    }
}

// MARK: - connect

struct ConnectView: View {
    @EnvironmentObject var glasses: GlassesLink
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(glasses.bleStatusText, systemImage: GlassesLink.isSimulator ? "exclamationmark.triangle" : "dot.radiowaves.left.and.right")
                        .foregroundStyle(GlassesLink.isSimulator || glasses.bleState != .poweredOn ? .orange : .primary)
                    if let e = glasses.lastError { Text(e).font(.footnote).foregroundStyle(.red) }
                }
                Section("Arms") {
                    ForEach(Side.allCases, id: \.self) { side in
                        let lens = glasses.lenses.first { $0.side == side }
                        HStack {
                            Image(systemName: side == .left ? "l.circle" : "r.circle").font(.title2)
                            VStack(alignment: .leading) {
                                Text(lens?.advert.name ?? "\(side.rawValue.capitalized) arm")
                                Text([glasses.state[side]?.rawValue, lens?.mac, lens?.advert.rssi.map { "\($0) dBm" }]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                                if let detail = glasses.armDetail[side] {
                                    Text(detail).font(.caption).foregroundStyle(glasses.state[side] == .failed ? .red : .secondary)
                                }
                                if !glasses.connected, lens?.advert.source == .systemConnected {
                                    Label("This arm is held by another app or iOS. Force-quit the Even app before connecting.",
                                          systemImage: "exclamationmark.triangle")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                            }
                            Spacer()
                            if glasses.state[side] == .authenticated { Image(systemName: "checkmark.seal.fill").foregroundStyle(.green) }
                        }
                    }
                    if let b = glasses.device.battery {
                        Label("Battery \(b)%\(glasses.device.charging == true ? " (charging)" : "")", systemImage: "battery.75")
                    }
                    if let fw = glasses.device.firmwareRight ?? glasses.device.firmwareLeft { Text("Firmware \(fw)").font(.caption) }
                    if let serial = glasses.pair?.serial, !serial.isEmpty { Text("Serial \(serial)").font(.caption).foregroundStyle(.secondary) }
                }
                Section {
                    if glasses.connected {
                        Button("Show Jarvis on the glasses again") { model.host.redraw() }
                        Button("Disconnect", role: .destructive) { glasses.disconnect() }
                    } else if glasses.busy {
                        Button("Cancel connection") { glasses.disconnect() }
                    } else if glasses.scanning {
                        HStack { ProgressView(); Text("Scanning… put the glasses on or open the case") }
                        Button("Stop") { glasses.stopScan() }
                    } else {
                        Button("Scan and connect") { glasses.startScan() }.disabled(glasses.busy)
                        if glasses.hasSavedPair {
                            Button("Reconnect to saved glasses") { Task { await glasses.reconnectSaved() } }.disabled(glasses.busy)
                            Button("Forget saved glasses", role: .destructive) { glasses.forget() }
                        }
                    }
                    if glasses.canConfirmListedArms {
                        Text("Both arms are visible. Confirm the listed arms belong to your glasses before connecting.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Connect listed arms") { Task { await glasses.connectListedArms() } }
                    }
                    if glasses.busy { HStack { ProgressView(); Text("Connecting…") } }
                } footer: {
                    Text("The glasses accept one phone at a time. Force-quit the Even app (and keep it closed) before connecting here. Keep the ring paired in the Even app; Jarvis tells the glasses to link it each session.")
                }
                RingSection()
            }
            .navigationTitle("Glasses")
        }
    }
}

/// The R1 ring: what we stored from its advert, what the glasses last reported, and its input count.
struct RingSection: View {
    @EnvironmentObject var glasses: GlassesLink

    var body: some View {
        Section {
            HStack {
                Image(systemName: "circle.circle").font(.title2)
                VStack(alignment: .leading) {
                    Text(glasses.ringName ?? (glasses.ringMacRaw == nil ? "No ring stored yet" : "R1 ring"))
                    Text(glasses.ringMacText.map { "MAC \($0)" } ?? "Tap Find ring with the Even app closed, then tap the ring.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if glasses.ringStatus?.linked == true { Image(systemName: "checkmark.seal.fill").foregroundStyle(.green) }
            }
            Text(glasses.ringStatusText).font(.caption)
            Text("Ring events \(glasses.ringEvents)\(glasses.ringMarkers > 0 ? " · activity markers \(glasses.ringMarkers)" : "")")
                .font(.caption)
            if glasses.ringSearching {
                HStack { ProgressView(); Text("Looking for the ring… tap it to wake it") }
            } else {
                Button("Find ring") { glasses.findRing() }.disabled(glasses.bleState != .poweredOn)
            }
            Button("Link ring to glasses") { glasses.linkRing() }.disabled(!glasses.canLinkRing)
            if glasses.ringHandoffRunning {
                HStack { ProgressView(); Text("Handing the ring to the glasses…") }
            } else {
                Button("Hand off ring directly (fallback)") { glasses.handOffRing() }.disabled(!glasses.canHandOffRing)
            }
            if let status = glasses.ringHandoffStatus { Text(status).font(.caption).foregroundStyle(.secondary) }
        } header: { Text("R1 ring") } footer: {
            Text("Ring input is relayed by the glasses (source = ring), and only while the Jarvis page is on the lenses. A 1-second hold opens the glasses menu. Use the direct handoff only if linking gives no linked status and no ring events.")
        }
    }
}

// MARK: - Jarvis page + lens preview

struct JarvisView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var mirror: LensMirror
    @State private var showPreview = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if showPreview {
                    LensPreview(page: mirror.page, selected: mirror.selected)
                        .padding(.horizontal)
                    GesturePad { model.host.simulate($0) }
                    if mirror.micOpen { Label("Mic open (\(mirror.micSource))", systemImage: "mic.fill").font(.caption).foregroundStyle(.red) }
                }
                Text(model.pageStatus).font(.caption2).foregroundStyle(.secondary).lineLimit(2).padding(.horizontal)
                WebViewHost(webView: model.webView)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .padding(.horizontal, 4)
            }
            .navigationTitle("Jarvis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(showPreview ? "Hide lens" : "Show lens") { showPreview.toggle() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.loadPage() } label: { Image(systemName: "arrow.clockwise") }
                }
            }
        }
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// A rough software rendering of what the page asked the lenses to show (576x288, green on black).
/// Fonts and line breaks differ from the firmware; it is for checking flow, not pixels.
struct LensPreview: View {
    let page: PageSpec?
    let selected: [Int: Int]

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width / CGFloat(Display.width)
            ZStack(alignment: .topLeading) {
                Color.black
                if let page {
                    ForEach(page.text, id: \.id) { t in
                        Text(t.content ?? "")
                            .font(.system(size: 17 * s, design: .monospaced))
                            .foregroundStyle(Color.green)
                            .padding(CGFloat(t.paddingLength) * s)
                            .frame(width: CGFloat(t.width) * s, height: CGFloat(t.height) * s, alignment: .topLeading)
                            .clipped()
                            .border(Color.green.opacity(t.borderWidth > 0 ? 0.8 : 0), width: CGFloat(max(t.borderWidth, 1)) * s)
                            .offset(x: CGFloat(t.x) * s, y: CGFloat(t.y) * s)
                    }
                    ForEach(page.list, id: \.id) { l in
                        VStack(alignment: .leading, spacing: 2 * s) {
                            ForEach(Array(l.items.enumerated()), id: \.offset) { i, item in
                                Text(item)
                                    .font(.system(size: 17 * s, design: .monospaced))
                                    .foregroundStyle(Color.green)
                                    .padding(.horizontal, 4 * s)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .overlay(RoundedRectangle(cornerRadius: 3 * s)
                                        .stroke(Color.green, lineWidth: (selected[l.id] ?? 0) == i && l.selectBorder ? 1.5 : 0))
                            }
                        }
                        .padding(CGFloat(l.paddingLength) * s)
                        .frame(width: CGFloat(l.width) * s, height: CGFloat(l.height) * s, alignment: .topLeading)
                        .clipped()
                        .offset(x: CGFloat(l.x) * s, y: CGFloat(l.y) * s)
                    }
                    ForEach(page.image, id: \.id) { i in
                        Rectangle().stroke(Color.green.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4]))
                            .frame(width: CGFloat(i.width) * s, height: CGFloat(i.height) * s)
                            .overlay(Text("image \(i.id)").font(.caption2).foregroundStyle(.green))
                            .offset(x: CGFloat(i.x) * s, y: CGFloat(i.y) * s)
                    }
                } else {
                    Text("No page yet. Load the Jarvis page (hub URL in Settings).")
                        .font(.caption).foregroundStyle(.green.opacity(0.7)).padding()
                }
            }
        }
        .aspectRatio(CGFloat(Display.width) / CGFloat(Display.height), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

/// Ring / temple gestures for testing without glasses (sent to the page with source = ring).
struct GesturePad: View {
    let send: (G2Kit.Gesture) -> Void
    @State private var holding = false

    var body: some View {
        HStack {
            Button { send(.scrollUp) } label: { Image(systemName: "chevron.up") }
            Button { send(.scrollDown) } label: { Image(systemName: "chevron.down") }
            Button("Tap") { send(.tap) }
            Button("Double") { send(.doubleTap) }
            Text(holding ? "Release" : "Hold")
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(holding ? Color.red.opacity(0.3) : Color.secondary.opacity(0.15), in: Capsule())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !holding { holding = true; send(.longPress) } }
                    .onEnded { _ in holding = false; send(.longPressRelease) })
        }
        .buttonStyle(.bordered)
        .font(.callout)
    }
}

// MARK: - settings

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var model: AppModel
    @State private var url = ""
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.2:8787", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Hub token", text: $token)
                    Button("Save and reload the Jarvis page") {
                        settings.hubURL = url
                        settings.token = token
                        model.loadPage()
                    }
                } header: { Text("Hub") } footer: {
                    Text("The hub on your Mac (same Wi-Fi, or its Tailscale address). The app loads \(settings.glassesPageURL?.absoluteString ?? "<hub>/glasses/") and the page connects to <hub>/ws. The token is kept in the Keychain.")
                }
                Section {
                    Toggle("Use the phone mic when no glasses are connected", isOn: $settings.phoneMicFallback)
                    Toggle("Reconnect to saved glasses automatically", isOn: $settings.autoConnect)
                } header: { Text("Behaviour") }
                Section {
                    Picker("Pipe role", selection: $settings.pipeRole) {
                        Text("1 (MentraOS)").tag(1)
                        Text("2 (Even app capture)").tag(2)
                    }
                    Toggle("Send dashboard prelude", isOn: $settings.dashboardPrelude)
                    Toggle("Send session init (onboarding skip, gesture control)", isOn: $settings.sessionInit)
                    Toggle("Fast image transfer", isOn: $settings.fastImages)
                } header: { Text("Protocol (takes effect on the next connect)") } footer: {
                    Text("Only change these if pages never appear on the lenses. Session init is what the drivers that receive ring gestures send after connecting; leave it on unless it breaks the session. Fast image transfer sends image packets as fast as Bluetooth takes them with two fragments in flight; off is the MentraOS pacing (6 ms gaps, one fragment per ACK). See native/PROTOCOL.md, open questions.")
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                url = settings.hubURL
                token = settings.token
            }
        }
    }
}

// MARK: - log

struct LogView: View {
    @EnvironmentObject var appLog: AppLog

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List(Array(appLog.lines.enumerated()), id: \.offset) { i, line in
                    Text(line).font(.system(size: 11, design: .monospaced)).id(i)
                }
                .listStyle(.plain)
                .onChange(of: appLog.lines.count) { _, n in if n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) } }
            }
            .navigationTitle("Log")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Clear") { appLog.clear() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // The whole Documents/jarvis.log (all sessions), not just the lines on screen.
                    ShareLink(item: AppLog.fileURL) { Image(systemName: "square.and.arrow.up") }
                    Button("Copy") { UIPasteboard.general.string = appLog.lines.joined(separator: "\n") }
                }
            }
        }
    }
}


// MARK: - hub pages (Studio, Agents)

/// A page served by your hub, shown full-screen in the app: Studio (vibe-code glasses apps with
/// Claude) and Agents (Claude Code + Codex agents, approvals, Copilot, notes).
struct HubPageView: View {
    @EnvironmentObject var settings: AppSettings
    let title: String
    let path: String
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            Group {
                if let url = pageURL {
                    HubWebView(url: url, reloadToken: reloadToken)
                } else {
                    ContentUnavailableView("Set your hub", systemImage: "network", description: Text("Enter the hub address and token in Settings."))
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { reloadToken += 1 } label: { Image(systemName: "arrow.clockwise") }
                }
            }
        }
    }

    private var pageURL: URL? {
        guard let base = settings.glassesPageURL?.deletingLastPathComponent() else { return nil }
        var c = URLComponents(url: base.appendingPathComponent(String(path.dropFirst())), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "token", value: settings.token)]
        return c?.url
    }
}

struct HubWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.lastRequestedURL = url
        coordinator.lastReload = reloadToken
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addScriptMessageHandler(coordinator, contentWorld: .page, name: Coordinator.handlerName)
        config.userContentController.addUserScript(WKUserScript(source: coordinator.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: .zero, configuration: config)
        coordinator.attach(web)
        web.uiDelegate = coordinator
        web.navigationDelegate = coordinator
        web.allowsBackForwardNavigationGestures = true
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator
        // Compare the requested URL: the phone page removes its token from browser history.
        if coordinator.lastReload != reloadToken || coordinator.lastRequestedURL != url {
            coordinator.stopCapture(reason: "Hub settings changed.")
            coordinator.lastReload = reloadToken
            coordinator.lastRequestedURL = url
            web.configuration.userContentController.removeAllUserScripts()
            web.configuration.userContentController.addUserScript(WKUserScript(source: coordinator.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            web.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.teardown()
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.handlerName, contentWorld: .page)
    }

    @MainActor
    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        static let handlerName = "jarvisPhoneMic"
        var lastReload = 0
        var lastRequestedURL: URL?
        private weak var webView: WKWebView?
        private let microphone = PhoneMic()
        private var generation = 0
        private var session: String?
        private var capturing = false
        private var backgroundObserver: NSObjectProtocol?

        private func port(_ scheme: String, _ explicit: Int?) -> Int {
            explicit.flatMap { $0 == 0 ? nil : $0 } ?? (scheme == "https" ? 443 : 80)
        }

        private func trusted(_ origin: WKSecurityOrigin) -> Bool {
            guard let expected = lastRequestedURL, let scheme = expected.scheme?.lowercased(), let host = expected.host?.lowercased(),
                  scheme == "http" || scheme == "https" else { return false }
            return origin.protocol.lowercased() == scheme && origin.host.lowercased() == host && port(scheme, origin.port) == port(scheme, expected.port)
        }

        private func trustedPage() -> Bool {
            guard let expected = lastRequestedURL, let current = webView?.url else { return false }
            let scheme = expected.scheme?.lowercased() ?? ""
            return (scheme == "http" || scheme == "https") && current.scheme?.lowercased() == scheme &&
                current.host?.lowercased() == expected.host?.lowercased() && port(scheme, current.port) == port(scheme, expected.port)
        }

        private var originJSON: String {
            let value: [String: Any] = ["scheme": lastRequestedURL?.scheme?.lowercased() ?? "",
                "host": lastRequestedURL?.host?.lowercased() ?? "", "port": port(lastRequestedURL?.scheme?.lowercased() ?? "", lastRequestedURL?.port)]
            return String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
        }

        var bridgeScript: String {
            """
            (() => {
              const expected = \(originJSON), u = new URL(location.href);
              const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
              if (u.protocol !== expected.scheme + ':' || u.hostname.toLowerCase() !== expected.host || port !== expected.port) return;
              const handler = window.webkit?.messageHandlers?.\(Self.handlerName);
              if (!handler) return;
              Object.defineProperty(window, 'jarvisPhoneMic', { value: Object.freeze({
                start(session) {
                  if (!navigator.userActivation?.isActive) return Promise.resolve({ok:false, error:'Tap Listen with phone mic to start recording.'});
                  return handler.postMessage({action:'start', session});
                },
                stop(session) { return handler.postMessage({action:'stop', session}); }
              }) });
            })();
            """
        }

        func attach(_ web: WKWebView) {
            webView = web
            microphone.onPCM = { [weak self] bytes in
                guard let self, self.capturing, let session = self.session, self.trustedPage() else { return }
                guard self.webView?.window != nil else { self.stopCapture(reason: "Page is no longer visible."); return }
                self.emit("jarvis-phone-mic-pcm", ["session": session, "pcm": Data(bytes).base64EncodedString()])
            }
            backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.stopCapture(reason: "App moved to the background.") }
            }
        }

        private func emit(_ event: String, _ detail: [String: Any]) {
            guard trustedPage(), let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
            // Repeat the origin gate inside JS, so queued PCM cannot reach a newly navigated origin.
            let script = "(() => { const e = \(originJSON), u = new URL(location.href); if (u.protocol === e.scheme + ':' && u.hostname.toLowerCase() === e.host && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === e.port) window.dispatchEvent(new CustomEvent('\(event)', {detail:\(json)})); })();"
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }

        func stopCapture(reason: String, notifyPage: Bool = true) {
            let stoppedSession = session
            generation += 1
            capturing = false
            session = nil
            microphone.stop()
            if notifyPage, let stoppedSession { emit("jarvis-phone-mic-stopped", ["session": stoppedSession, "reason": reason]) }
        }

        func teardown() {
            stopCapture(reason: "Page closed.")
            microphone.onPCM = nil
            if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
            backgroundObserver = nil
            webView = nil
        }

        nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            MainActor.assumeIsolated {
                guard message.frameInfo.isMainFrame, message.webView === webView, trusted(message.frameInfo.securityOrigin), trustedPage(),
                      let body = message.body as? [String: Any], let action = body["action"] as? String else {
                    replyHandler(nil, "Microphone access is restricted to your hub's main page.")
                    return
                }
                if action == "stop" {
                    if let target = body["session"] as? String, target != session { replyHandler(["ok": true], nil); return }
                    stopCapture(reason: "Stopped.")
                    replyHandler(["ok": true], nil)
                    return
                }
                guard action == "start", UIApplication.shared.applicationState == .active, webView?.window != nil else {
                    replyHandler(["ok": false, "error": "Open Jarvis and tap Listen with phone mic."], nil)
                    return
                }
                guard session == nil else {
                    replyHandler(["ok": false, "error": "A microphone request is already active."], nil)
                    return
                }
                generation += 1
                let attempt = generation
                guard let requestedSession = body["session"] as? String, !requestedSession.isEmpty, requestedSession.count <= 100 else {
                    replyHandler(["ok": false, "error": "Invalid microphone session."], nil)
                    return
                }
                session = requestedSession
                Task { @MainActor in
                    let ok = await microphone.start()
                    guard attempt == generation, session == requestedSession else {
                        replyHandler(["ok": false, "error": "Microphone start was cancelled."], nil)
                        return
                    }
                    guard ok, trustedPage(), UIApplication.shared.applicationState == .active, webView?.window != nil else {
                        let error = microphone.lastError ?? "The phone microphone is unavailable."
                        stopCapture(reason: error, notifyPage: false)
                        replyHandler(["ok": false, "error": error], nil)
                        return
                    }
                    capturing = true
                    replyHandler(["ok": true, "session": requestedSession, "sampleRate": 16000], nil)
                }
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { stopCapture(reason: "Page navigation.") }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { stopCapture(reason: "Page stopped.") }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(frame.isMainFrame && trusted(origin) && type == .microphone ? .grant : .deny)
        }
    }
}
