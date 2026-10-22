// G2Driver: talk to Even G2 glasses directly, with an API shaped like the Even Hub SDK bridge
// (createStartUpPageContainer / rebuildPageContainer / textContainerUpgrade / updateImageRawData /
// audioControl / imuControl / onEvenHubEvent). Port of native/driver/src/driver.ts.
//
// Session behaviour follows MentraOS G2.swift / G2.kt, workbench g2_connection.dart and
// men-g2-ble-gateway (fw 2.2.20). Reimplemented.
//
//   both lenses : subscribe notify (5402, mandatory) + audio (6402, if present; non-fatal), AUTH
//                 (each waits up to 3 s for its secAuth verdict, non-fatal), TIME_SYNC, dev-settings heartbeat
//   right lens  : PIPE_ROLE_CHANGE, onboarding skip (0x10) + gesture_ctrl init (0x0D), every
//                 EvenHub/UI message, EvenHub heartbeat, RING_CONNECT_INFO
//   left lens   : nothing else (and its mic notifications)
//
// Everything runs on the main actor: CoreBluetooth delivers on the main queue, the WKWebView bridge
// lives there, and the work per notification is tiny (5 LC3 frames per 50 ms).

import Foundation

public struct DriverOptions {
    /// Delay between handshake steps (MentraOS/gateway: 200 ms).
    public var stepDelayMs = 200
    /// Gap between packets of one multi-packet message (gateway: 8 ms, iOS MentraOS: 6 ms).
    public var packetGapMs = 6
    /// EvenHub + dev-settings heartbeat period. The glasses drop the page/mic after ~10 s of silence. 0 disables.
    public var heartbeatMs = 5000
    /// Per-fragment image ACK timeout (MentraOS: 2000 ms) and attempts (3).
    public var imageAckTimeoutMs = 2000
    public var imageAttempts = 3
    /// Image packets go out as fast as the link takes them (each waits for CoreBluetooth's write
    /// buffer, at most `writableWaitMs`) instead of `packetGapMs` apart. ~92 packets per 288x144 tile,
    /// so the fixed gap alone costs ~0.5 s per tile. A wait that times out sends the rest of that image
    /// with the gap; a failed image switches to the gap for the session.
    public var imageFlowControl = true
    public var writableWaitMs = 40
    /// Image fragments sent ahead before waiting for the oldest ACK (MentraOS: 1). With 2, the next
    /// 4 KB fragment is on the air while the glasses ACK the previous one. Falls back to 1 for the
    /// session if a multi-fragment image fails.
    public var imageWindow = 2
    /// Also send the dashboard (0x01) "app launch" message the Even App sends at start-up (captured in
    /// g2-kit-unofficial). Off by default (MentraOS does not send it). Try it if pages never appear.
    public var dashboardPrelude = false
    /// PIPE_ROLE_CHANGE value for the right lens: 1 per MentraOS (default), 2 per the i-soxi capture.
    public var pipeRole = 1
    /// AuthMgr.phoneType in AUTH: 3 = PHONE_IOS (MentraOS iOS, workbench on iOS), 4 = PHONE_ANDROID.
    public var phoneType = PhoneType.ios
    /// Send onboarding skip (service 0x10) and gesture_ctrl init (0x0D) to the right lens after
    /// TIME_SYNC, as both drivers that receive ring events do.
    public var sessionInit = true
    /// How long to wait for each lens's AUTH ack before carrying on unauthenticated (non-fatal).
    public var authAckTimeoutMs = 3000
    /// After attach, count 0x80 heartbeat replies per lens against heartbeats sent for this long,
    /// then log the counts (more replies than sent = another app drives the link). 0 disables.
    public var contentionWindowMs = 30_000
    /// LC3 decoder; without it audio handlers still get raw LC3 frames.
    public var lc3: Lc3Decoding?
    public var log: ((String) -> Void)?

    public init(stepDelayMs: Int = 200, packetGapMs: Int = 6, heartbeatMs: Int = 5000, imageAckTimeoutMs: Int = 2000, imageAttempts: Int = 3,
                imageFlowControl: Bool = true, writableWaitMs: Int = 40, imageWindow: Int = 2, dashboardPrelude: Bool = false, pipeRole: Int = 1, phoneType: Int = PhoneType.ios, sessionInit: Bool = true,
                authAckTimeoutMs: Int = 3000, contentionWindowMs: Int = 30_000, lc3: Lc3Decoding? = nil, log: ((String) -> Void)? = nil) {
        self.stepDelayMs = stepDelayMs; self.packetGapMs = packetGapMs; self.heartbeatMs = heartbeatMs
        self.imageAckTimeoutMs = imageAckTimeoutMs; self.imageAttempts = imageAttempts; self.dashboardPrelude = dashboardPrelude
        self.imageFlowControl = imageFlowControl; self.writableWaitMs = writableWaitMs; self.imageWindow = imageWindow
        self.pipeRole = pipeRole; self.phoneType = phoneType; self.sessionInit = sessionInit
        self.authAckTimeoutMs = authAckTimeoutMs; self.contentionWindowMs = contentionWindowMs; self.lc3 = lc3; self.log = log
    }
}

public struct AudioChunk {
    public let lc3Frames: [[UInt8]]
    /// s16le 16 kHz mono, when a decoder is configured.
    public let pcm: [UInt8]?
    public let side: Side
    public let raw: [UInt8]
}

/// Timing of one updateImageRawData (G2Driver.lastImage), for the per-frame log line.
public struct ImageStats: Equatable {
    public var containerId: Int
    public var bytes: Int
    public var fragments: Int
    /// BLE packets written, over all attempts.
    public var packets = 0
    public var attempts = 0
    public var ok = false
    /// From the call to the last ACK (or the failure).
    public var totalMs = 0
    /// Waiting behind other messages to the right lens before the first image packet went out.
    public var queueMs = 0
    /// From a fragment's last packet being handed to the radio to its ACK.
    public var ackAvgMs = 0
    public var ackMaxMs = 0
    /// Packets that waited for CoreBluetooth's write buffer, the total wait, and waits that timed out
    /// (after one, the rest of that attempt used the fixed gap: iOS reports no readiness in the background).
    public var stalls = 0
    public var stallMs = 0
    public var stallTimeouts = 0
    /// How the last attempt was sent: "flow+w2" (flow control, 2 fragments in flight), "flow", "gap6".
    public var mode = ""
    /// Payload format of the last attempt (ImageFormats.swift) and its size on the wire.
    public var format = ImageFormat.standard
    public var payloadBytes = 0

    public var summary: String {
        var s = "\(fragments) frags \(packets) pkts, queue \(queueMs)ms, ack avg \(ackAvgMs) max \(ackMaxMs)ms"
        if stalls > 0 { s += ", stalls \(stalls)/\(stallMs)ms" }
        if stallTimeouts > 0 { s += " (\(stallTimeouts) timed out)" }
        s += ", \(mode)"
        if format != .standard { s += String(format: ", %@ %.1fKB", format.rawValue, Double(payloadBytes) / 1000) }
        if attempts > 1 { s += ", \(attempts) attempts" }
        return s
    }
}

/// Per-transfer counters filled in by the write loop.
@MainActor
private final class TransferMeter {
    var packets = 0
    var stalls = 0
    var stallMs = 0.0
    var stallTimeouts = 0
    var firstWrite: Date?
    /// A write-buffer wait timed out: fixed gap for the rest of the transfer.
    var flowDead = false
    /// When each message's last packet was handed to the radio, by enqueue order.
    var messageDone: [Date] = []
}

private enum Pacing {
    /// `packetGapMs` between packets (every message except images).
    case gap
    /// Wait only for the write buffer (images).
    case flow
}

public enum DriverEvent: Equatable {
    case hub(HubEvent)
    case device(DeviceInfo)
    case authenticated(Side, Bool)
    case disconnected(Side)
    /// The glasses reported the R1 link (RING_CONNECT_INFO / DISCONNECT_INFO / UNPAIR_INFO reply).
    case ring(RingStatus)
}

public enum DriverError: Error, Equatable, CustomStringConvertible {
    /// A lens dropped while the handshake ran. Its `.disconnected` event had no listener yet, so
    /// attach fails instead of returning a session with a dead lens that never reconnects.
    case lensDisconnected(Side)
    public var description: String {
        switch self {
        case .lensDisconnected(let side): return "\(side.rawValue) lens disconnected during the handshake"
        }
    }
}

@MainActor
private final class Pending<T> {
    let match: (T) -> Bool
    private var done = false
    private var value: T?
    private var cont: CheckedContinuation<T?, Never>?
    /// When it resolved (an ACK's arrival time, even if nobody was waiting yet).
    private(set) var resolvedAt: Date?

    init(match: @escaping (T) -> Bool) { self.match = match }

    func resolve(_ v: T?) {
        guard !done else { return }
        done = true
        resolvedAt = Date()
        value = v
        cont?.resume(returning: v)
        cont = nil
    }

    func wait() async -> T? {
        if done { return value }
        return await withCheckedContinuation { c in
            if done { c.resume(returning: value) } else { cont = c }
        }
    }
}

private func sleepMs(_ ms: Int) async {
    if ms > 0 { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }
}

/// "3 s" / "250 ms".
private func durationText(_ ms: Int) -> String { ms > 0 && ms % 1000 == 0 ? "\(ms / 1000) s" : "\(ms) ms" }

private func tag(_ side: Side) -> String { side == .left ? "L" : "R" }

private func ms(since d: Date) -> Int { Int(Date().timeIntervalSince(d) * 1000) }

@MainActor
public final class G2Driver {
    public let left: BlePeripheral
    public let right: BlePeripheral
    private let opt: DriverOptions
    private let sync = Counter8(0)
    private let magic = Counter8(0)
    private var imageSession = 0
    /// Image pacing for this session; a failed image steps it down (window, then flow control).
    private var imageWindowNow: Int
    private var imageFlowNow: Bool
    /// Experimental image formats the glasses NAKed or timed out on: standard BMP instead, this session.
    public private(set) var rejectedFormats: Set<ImageFormat> = []
    private let rx = Reassembler()
    private let dedupe = AudioDeduper()
    private var tails: [Side: Task<Void, Never>] = [:]
    private var unsubs: [() -> Void] = []
    private var heartbeatTask: Task<Void, Never>?
    private var hubWaiters: [UUID: Pending<HubEvent>] = [:]
    private var authWaiters: [Side: Pending<Bool>] = [:]
    /// Lenses whose AUTH reply carried no secAuth verdict (still waiting for the verdict).
    private var authNoVerdict: Set<Side> = []
    private var contentionTask: Task<Void, Never>?
    private var countingHeartbeats = false
    private var heartbeatsSent: [Side: Int] = [.left: 0, .right: 0]
    private var heartbeatReplies: [Side: Int] = [.left: 0, .right: 0]
    private var inputHandlers: [UUID: (InputEvent) -> Void] = [:]
    private var audioHandlers: [UUID: (AudioChunk) -> Void] = [:]
    private var eventHandlers: [UUID: (DriverEvent) -> Void] = [:]
    private var lastInput: (key: String, side: Side, at: Date)?
    private var pageCreated = false
    private var closed = false

    /// True once the glasses ACKed AUTH on that lens. attach() succeeds without it (the UI shows
    /// "connected (not authenticated)"); a late ack still sets it and emits `.authenticated`.
    public private(set) var authenticated: [Side: Bool] = [.left: false, .right: false]
    /// Lenses that have the 6402 mic characteristic and accepted the subscription.
    public private(set) var audioSubscribed: [Side: Bool] = [.left: false, .right: false]
    /// Lenses that reported a disconnect (also emitted as `.disconnected`, to listeners present then).
    public private(set) var disconnectedSides: Set<Side> = []
    /// Last ring status the glasses reported.
    public private(set) var ringStatus: RingStatus?
    /// Ring activity markers seen (ring Sys events with no type field).
    public private(set) var ringActivityCount = 0
    /// False after the firmware closed our page (system exit, double-tap exit, dashboard...).
    public private(set) var pageAlive = false
    public private(set) var micOn = false
    public private(set) var device = DeviceInfo()
    /// Timing of the last setImage call.
    public private(set) var lastImage: ImageStats?

    private init(left: BlePeripheral, right: BlePeripheral, options: DriverOptions) {
        self.left = left
        self.right = right
        self.opt = options
        imageWindowNow = max(1, options.imageWindow)
        imageFlowNow = options.imageFlowControl
        rx.onRejected = { [weak self] p, source in
            let side = source == Side.left.rawValue ? "L" : source == Side.right.rawValue ? "R" : source
            self?.log("RX rejected \(side) svc 0x\(String(format: "%02x", p.service)) sync \(p.syncId) result \(p.resultCode)")
        }
    }

    /// Use already-connected peripherals (any transport) and run the handshake.
    public static func attach(left: BlePeripheral, right: BlePeripheral, options: DriverOptions = DriverOptions()) async throws -> G2Driver {
        let d = G2Driver(left: left, right: right, options: options)
        do {
            try await d.start()
            return d
        } catch {
            d.close()
            throw error
        }
    }

    private func log(_ m: String) { opt.log?(m) }

    private func peripheral(_ side: Side) -> BlePeripheral { side == .left ? left : right }

    private func start() async throws {
        for side in Side.allCases {
            let p = peripheral(side)
            unsubs.append(try await p.subscribe(G2UUID.notify) { [weak self] d in self?.onNotify(d, side: side) })
            await sleepMs(min(opt.stepDelayMs, 50))
            // 6402 lives in its own GATT service (…6450) on current firmware; the mic is optional.
            if p.has(G2UUID.audioNotify) {
                do {
                    unsubs.append(try await p.subscribe(G2UUID.audioNotify) { [weak self] d in self?.onAudio(d, side: side) })
                    audioSubscribed[side] = true
                } catch {
                    log("\(tag(side)) audio 6402 subscribe failed (continuing without this mic): \(error)")
                }
            } else {
                log("\(tag(side)) has no audio characteristic 6402 (continuing without this mic)")
            }
            p.onDisconnect { [weak self] in
                self?.disconnectedSides.insert(side)
                self?.emit(.disconnected(side))
            }
        }
        let step = opt.stepDelayMs
        try await authenticate(.left)
        await sleepMs(step)
        try await authenticate(.right)
        await sleepMs(step)
        try await sendTo(.right, Service.deviceSettings, DevConfig.pipeRoleChange(magic: magic.next(), role: opt.pipeRole))
        await sleepMs(step)
        // One TIME_SYNC message to both lenses, as MentraOS and workbench do.
        let time = DevConfig.timeSync(magic: magic.next())
        try await sendTo(.left, Service.deviceSettings, time)
        try await sendTo(.right, Service.deviceSettings, time)
        await sleepMs(step)
        if opt.sessionInit {
            try await sendTo(.right, Service.onboarding, SessionInit.skipOnboarding(magic: magic.next()))
            try await sendTo(.right, Service.gestureCtrl, SessionInit.gestureCtrlInit(magic: magic.next()))
            log("session init sent to R (onboarding skip 0x10, gesture_ctrl init 0x0d)")
            await sleepMs(step)
        }
        if opt.dashboardPrelude {
            // {1: 2, 2: magic, 4: {3: {2: {2: {1: 0, 2: 0}}}}} - bytes from the Even App capture, fresh magic.
            let body = PbWriter().message(3, PbWriter().message(2, PbWriter().message(2, PbWriter().int(1, 0).int(2, 0))))
            try await sendTo(.right, Service.dashboard, PbWriter().int(1, 2).int(2, Int(magic.next())).message(4, body).finish())
            await sleepMs(step)
        }
        // A lens that dropped during a step delay, after its last write, would otherwise go unnoticed:
        // nobody listened for its `.disconnected` yet. No await follows, so nothing can slip in after this.
        if let side = Side.allCases.first(where: disconnectedSides.contains) {
            log("\(tag(side)) disconnected during the handshake")
            throw DriverError.lensDisconnected(side)
        }
        if opt.heartbeatMs > 0 {
            let period = opt.heartbeatMs
            if opt.contentionWindowMs > 0 {
                countingHeartbeats = true
                let window = opt.contentionWindowMs
                contentionTask = Task { [weak self] in
                    await sleepMs(window)
                    guard let self, !Task.isCancelled else { return }
                    self.reportContention(windowMs: window)
                }
            }
            heartbeatTask = Task { [weak self] in
                while !Task.isCancelled {
                    await sleepMs(period)
                    guard let self, !Task.isCancelled else { return }
                    await self.beat()
                }
            }
        }
        log("handshake sent (auth L=\(authenticated[.left] == true ? "ok" : "no") R=\(authenticated[.right] == true ? "ok" : "no"))")
    }

    /// AUTH one lens and wait up to `authAckTimeoutMs` for its ack. Only a failed write throws.
    private func authenticate(_ side: Side) async throws {
        let pending = Pending<Bool>(match: { _ in true })
        authWaiters[side] = pending
        authNoVerdict.remove(side)
        defer { if authWaiters[side] === pending { authWaiters[side] = nil } }
        log("AUTH → \(tag(side)) phoneType \(opt.phoneType)")
        let started = Date()
        try await sendTo(side, Service.deviceSettings, DevConfig.auth(magic: magic.next(), phoneType: opt.phoneType))
        let timeout = opt.authAckTimeoutMs
        let timer = Task { await sleepMs(timeout); pending.resolve(nil) }
        let ok = await pending.wait()
        timer.cancel()
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        switch ok {
        case true?: log("\(tag(side)) AUTH ack ok in \(ms) ms")
        case false?: log("\(tag(side)) AUTH ack rejected (secAuth false) in \(ms) ms")
        case nil where authNoVerdict.contains(side):
            log("\(tag(side)) AUTH replied without a secAuth verdict, and no verdict followed in \(durationText(timeout))")
        case nil: log("\(tag(side)) AUTH no ack in \(durationText(timeout))")
        }
    }

    private func beat() async {
        if pageCreated {
            do { try await sendTo(.right, Service.evenHub, EvenHub.heartbeat(magic: magic.next())) } catch {
                log("heartbeat failed: R EvenHub: \(error)")
            }
        }
        // Dev-settings heartbeat to BOTH lenses: without traffic on the left link iOS can drop it
        // after ~50 s in the background (MentraOS: disconnect reason 722).
        let hb = DevConfig.heartbeat(magic: magic.next())
        for side in [Side.right, Side.left] {
            do {
                try await sendTo(side, Service.deviceSettings, hb)
                if countingHeartbeats { heartbeatsSent[side, default: 0] += 1 }
            } catch {
                log("heartbeat failed: \(tag(side)) 0x80: \(error)")
            }
        }
    }

    private func reportContention(windowMs: Int) {
        countingHeartbeats = false
        for side in Side.allCases {
            let replies = heartbeatReplies[side] ?? 0, sent = heartbeatsSent[side] ?? 0
            var line = "\(tag(side)) 0x80 replies \(replies) vs \(sent) sent in \(durationText(windowMs))"
            if replies > sent + 1 { line += " — another app is driving this link (Even app?)" }
            else if replies == 0 && sent > 0 { line += " — this lens is not answering heartbeats" }
            log(line)
        }
    }

    // MARK: sending

    /// Frame and write one logical message to one lens. Messages never interleave on a lens.
    public func sendTo(_ side: Side, _ service: UInt8, _ payload: [UInt8]) async throws {
        try await enqueue(side, service, payload).value
    }

    /// Queue one message behind the lens's previous one (synchronously, so queue order is call order)
    /// and return the task that writes it.
    private func enqueue(_ side: Side, _ service: UInt8, _ payload: [UInt8], pacing: Pacing = .gap, meter: TransferMeter? = nil) throws -> Task<Void, Error> {
        let packets = try buildPackets(payload, syncId: sync.next(), service: service)
        let p = peripheral(side)
        let prev = tails[side]
        let gap = opt.packetGapMs
        let waitMs = opt.writableWaitMs
        let task = Task<Void, Error> { @MainActor in
            await prev?.value
            for (i, pkt) in packets.enumerated() {
                // A buffer wait that times out means iOS is not reporting readiness (a backgrounded
                // central): the rest of this transfer goes back to the fixed gap.
                let flow = pacing == .flow && meter?.flowDead != true
                if flow {
                    let t = Date()
                    let ready = await p.waitWritable(timeoutMs: waitMs)
                    let waited = Date().timeIntervalSince(t) * 1000
                    if waited >= 0.5 || !ready {
                        meter?.stalls += 1
                        meter?.stallMs += waited
                        if !ready {
                            meter?.stallTimeouts += 1
                            meter?.flowDead = true
                        }
                    }
                }
                if meter?.firstWrite == nil { meter?.firstWrite = Date() }
                try await p.write(G2UUID.write, pkt, withoutResponse: true)
                meter?.packets += 1
                if !flow, i < packets.count - 1 { await sleepMs(gap) }
            }
            meter?.messageDone.append(Date())
        }
        tails[side] = Task { _ = try? await task.value }
        return task
    }

    private func hub(_ payload: [UInt8]) async throws {
        try await sendTo(.right, Service.evenHub, payload)
    }

    // MARK: SDK-shaped API

    /// createStartUpPageContainer. The first call creates; later calls rebuild (a second CREATE is not ACKed).
    public func createPage(_ spec: PageSpec) async throws {
        if pageCreated { return try await rebuildPage(spec) }
        try await hub(EvenHub.createPage(spec, magic: magic.next()))
        pageCreated = true
        pageAlive = true
    }

    /// rebuildPageContainer: replace the whole layout.
    public func rebuildPage(_ spec: PageSpec) async throws {
        if !pageCreated { return try await createPage(spec) }
        try await hub(EvenHub.rebuildPage(spec, magic: magic.next()))
        pageAlive = true
    }

    /// textContainerUpgrade: replace the text of one container in place.
    public func setText(_ containerId: Int, _ content: String) async throws {
        try await hub(EvenHub.updateText(containerId: containerId, content: content.isEmpty ? " " : content, magic: magic.next()))
    }

    /// updateImageRawData with a ready 4-bit BMP, in 4 KB fragments under one session id. Each
    /// fragment is ACKed (ErrorCode 4 = ok, 5 = failed). Up to `imageWindow` fragments are in flight
    /// (MentraOS: one at a time), and image packets use flow control instead of the fixed gap. The whole
    /// image is retried with a fresh session id on failure/timeout; a failure also steps this session
    /// down to the MentraOS behaviour (window 1, then the fixed gap). Returns false if all attempts
    /// failed. Timing lands in `lastImage`.
    ///
    /// `format` (opt-in, default standard) re-encodes the BMP as an experimental payload. If the
    /// glasses NAK or time out on it, the format is rejected for the session and the image goes again
    /// as a standard BMP; `force` (the LENS TEST page) skips both, so the push reports the format's own result.
    public func setImage(_ containerId: Int, bmp: [UInt8], containerName: String? = nil,
                         format: ImageFormat = .standard, force: Bool = false) async throws -> Bool {
        var fmt = force || !rejectedFormats.contains(format) ? format : .standard
        let started = Date()
        let fragments = (bmp.count + Display.imageFragmentBytes - 1) / Display.imageFragmentBytes
        var stats = ImageStats(containerId: containerId, bytes: bmp.count, fragments: fragments)
        var acks: [Double] = []
        defer {
            stats.totalMs = ms(since: started)
            stats.ackAvgMs = acks.isEmpty ? 0 : Int(acks.reduce(0, +) / Double(acks.count))
            stats.ackMaxMs = Int(acks.max() ?? 0)
            lastImage = stats
        }
        for attempt in 1...max(1, opt.imageAttempts) {
            imageSession = (imageSession + 1) % 256
            let session = imageSession
            var built = EvenHub.imageMessages(containerId: containerId, bmp: bmp, sessionId: session, containerName: containerName, format: fmt)
            if built == nil {
                log("image: \(fmt.rawValue) needs a plain 4-bit BMP; sending it as standard")
                fmt = .standard
                built = (EvenHub.imageMessages(containerId: containerId, bmp: bmp, sessionId: session, containerName: containerName), bmp.count)
            }
            let msgs = built!.messages
            stats.format = fmt
            stats.payloadBytes = built!.bytes
            stats.fragments = msgs.count
            let window = min(imageWindowNow, msgs.count)
            let pacing: Pacing = imageFlowNow ? .flow : .gap
            stats.attempts = attempt
            stats.mode = imageFlowNow ? (window > 1 ? "flow+w\(window)" : "flow") : "gap\(opt.packetGapMs)"
            let meter = TransferMeter()
            defer {
                stats.packets += meter.packets
                stats.stalls += meter.stalls
                stats.stallMs += Int(meter.stallMs)
                stats.stallTimeouts += meter.stallTimeouts
                if attempt == 1, let first = meter.firstWrite { stats.queueMs = Int(first.timeIntervalSince(started) * 1000) }
            }
            var inFlight: [(index: Int, ack: Pending<HubEvent>, sent: Task<Void, Error>)] = []
            var failed: (index: Int, timedOut: Bool)?
            /// Wait for the oldest fragment in flight; false if it was not ACKed as a success.
            func settleOldest() async throws -> Bool {
                let f = inFlight.removeFirst()
                try await f.sent.value
                let r = await f.ack.wait()
                if r != nil, let at = f.ack.resolvedAt, meter.messageDone.indices.contains(f.index) {
                    acks.append(max(0, at.timeIntervalSince(meter.messageDone[f.index]) * 1000))
                }
                if case let .result(_, code, _, _)? = r, code == HubResult.imageSuccess { return true }
                failed = (f.index, r == nil)
                return false
            }
            for (i, msg) in msgs.enumerated() {
                // Registered before the first packet goes out, so an early ACK is never missed.
                let ack = waitFor(timeoutMs: opt.imageAckTimeoutMs) { e in
                    if case let .result(_, code, s, f) = e { return s == session && (f ?? 0) == i && (code == HubResult.imageSuccess || code == HubResult.imageFailed) }
                    return false
                }
                inFlight.append((i, ack, try enqueue(.right, Service.evenHub, msg, pacing: pacing, meter: meter)))
                if inFlight.count >= window, !(try await settleOldest()) { break }
            }
            while failed == nil, !inFlight.isEmpty {
                if !(try await settleOldest()) { break }
            }
            guard let failed else {
                stats.ok = true
                return true
            }
            log("image \(containerId) fragment \(failed.index) \(failed.timedOut ? "timed out" : "failed") (attempt \(attempt), \(stats.mode))")
            if fmt != .standard {
                rejectedFormats.insert(fmt)
                if force { return false }
                log("image: \(fmt.rawValue) rejected by the glasses; standard BMP from now on (this session)")
                fmt = .standard
            } else if window > 1 {
                imageWindowNow = 1
                log("image: one fragment in flight from now on (this session)")
            } else if imageFlowNow {
                imageFlowNow = false
                log("image: fixed \(opt.packetGapMs) ms packet gap from now on (this session)")
            }
        }
        return false
    }

    public func setImage(_ containerId: Int, image: GrayImage, containerName: String? = nil,
                         format: ImageFormat = .standard, force: Bool = false) async throws -> Bool {
        try await setImage(containerId, bmp: build4BitBmp(image), containerName: containerName, format: format, force: force)
    }

    /// audioControl. The mic only runs while one of our pages is up, and dies with the page.
    @discardableResult
    public func startMic(_ onAudio: ((AudioChunk) -> Void)? = nil) async throws -> () -> Void {
        let off = onAudio.map { onAudioData($0) } ?? {}
        try await hub(EvenHub.audioControl(true, magic: magic.next()))
        micOn = true
        return off
    }

    public func stopMic() async throws {
        try await hub(EvenHub.audioControl(false, magic: magic.next()))
        micOn = false
    }

    /// imuControl. reportFrq is a pacing code 100..1000. Requires a live page.
    public func setImu(_ enable: Bool, reportFrq: Int = 100) async throws {
        try await hub(EvenHub.imuControl(enable, reportFrq: reportFrq, magic: magic.next()))
    }

    /// shutDownPageContainer. exitMode 0 = exit immediately, 1 = ask the user (SDK semantics).
    public func shutdown(exitMode: Int = 0) async throws {
        try await hub(EvenHub.shutdownPage(exitMode: exitMode))
        pageAlive = false
    }

    /// Battery / charging / firmware, via service 0x09. Returns what is known after the timeout.
    public func requestDeviceInfo(timeoutMs: Int = 3000) async throws -> DeviceInfo {
        let pending = Pending<DeviceInfo>(match: { _ in true })
        let id = UUID()
        eventHandlers[id] = { e in if case let .device(info) = e { pending.resolve(info) } }
        let timer = Task { await sleepMs(timeoutMs); pending.resolve(nil) }
        defer {
            eventHandlers[id] = nil
            timer.cancel()
        }
        try await sendTo(.right, Service.g2Setting, DevConfig.requestDeviceInfo(magic: magic.next()))
        return await pending.wait() ?? device
    }

    public func setBrightness(_ level: Int, auto: Bool = false) async throws {
        try await sendTo(.right, Service.g2Setting, DevConfig.setBrightness(magic: magic.next(), level: level, auto: auto))
    }

    /// RING_CONNECT_INFO to the right lens: ask the glasses to connect (or drop) the R1 ring.
    /// `macRaw` is the ring MAC in RAW advertisement order (RingAdvert.macRaw), not reversed.
    /// Replies arrive as `DriverEvent.ring`.
    public func bindRing(macRaw: [UInt8], connect: Bool = true, ringName: String? = nil) async throws {
        guard macRaw.count == 6 else { throw RingError.badMac(count: macRaw.count) }
        let name = ringName ?? ""
        log("ring: RING_CONNECT_INFO\(connect ? "" : " (disconnect)") → R mac \(formatMac(macRaw)) (raw) name \(name.isEmpty ? "-" : name)")
        try await sendTo(.right, Service.deviceSettings, DevConfig.ringConnectInfo(magic: magic.next(), connect: connect, ringMac: macRaw, ringName: name))
    }

    // MARK: events

    /// onEvenHubEvent, reduced to input events. Ring gestures arrive here via the glasses.
    @discardableResult
    public func onInput(_ h: @escaping (InputEvent) -> Void) -> () -> Void {
        let id = UUID()
        inputHandlers[id] = h
        return { [weak self] in self?.inputHandlers[id] = nil }
    }

    @discardableResult
    public func onAudioData(_ h: @escaping (AudioChunk) -> Void) -> () -> Void {
        let id = UUID()
        audioHandlers[id] = h
        return { [weak self] in self?.audioHandlers[id] = nil }
    }

    @discardableResult
    public func onEvent(_ h: @escaping (DriverEvent) -> Void) -> () -> Void {
        let id = UUID()
        eventHandlers[id] = h
        return { [weak self] in self?.eventHandlers[id] = nil }
    }

    private func emit(_ e: DriverEvent) {
        for h in Array(eventHandlers.values) { h(e) }
    }

    private func waitFor(timeoutMs: Int, _ match: @escaping (HubEvent) -> Bool) -> Pending<HubEvent> {
        let id = UUID()
        let p = Pending<HubEvent>(match: match)
        hubWaiters[id] = p
        Task { [weak self] in
            await sleepMs(timeoutMs)
            p.resolve(nil)
            self?.hubWaiters[id] = nil
        }
        return p
    }

    /// Feed one notification from the command channel (public so other transports can push data in).
    public func onNotify(_ data: [UInt8], side: Side) {
        if let msg = rx.push(data, source: side.rawValue) { dispatch(msg, side: side) }
    }

    private func dispatch(_ msg: FramedMessage, side: Side) {
        if msg.crcOk == false { log("CRC mismatch from \(side) service 0x\(String(msg.service, radix: 16)) (kept)") }
        switch msg.service {
        case Service.evenHub:
            for e in parseHubPayload(msg.payload) { handleHub(e, side: side) }
        case Service.deviceSettings:
            switch parseDevPayload(msg.payload) {
            case let .auth(verdict):
                // Only a verdict changes the state. The verdict-less reply that precedes it is not a
                // rejection: it must neither end the wait nor flip an authenticated lens back.
                guard let ok = verdict else {
                    authNoVerdict.insert(side)
                    log("\(tag(side)) AUTH reply without a secAuth verdict (\(hex(msg.payload)))\(authWaiters[side] == nil ? "" : "; waiting for the verdict")")
                    break
                }
                authenticated[side] = ok
                if !ok { log("\(tag(side)) AUTH reply secAuth false (\(hex(msg.payload)))") }
                if let w = authWaiters[side] { w.resolve(ok) } else { log("\(tag(side)) AUTH ack \(ok ? "ok" : "rejected") (late)") }
                emit(.authenticated(side, ok))
            case .heartbeat:
                if countingHeartbeats { heartbeatReplies[side, default: 0] += 1 }
            case let .ringInfo(status):
                // Both lenses acknowledge RING_CONNECT_INFO with an empty RingInfo; keep the last real status.
                if !status.isAckOnly { ringStatus = status }
                log("ring: status from \(tag(side)) \(status.summary)")
                emit(.ring(status))
            case .other:
                break
            }
        case Service.g2Setting:
            if let info = parseSettingPayload(msg.payload) {
                device = device.merged(with: info)
                emit(.device(device))
            }
        case 0x90, 0x91:
            // Ring-related services nobody has decoded yet: keep the raw bytes for the log.
            log("RX \(tag(side)) svc 0x\(String(format: "%02x", msg.service)) \(hex(msg.payload))")
        default:
            break
        }
    }

    private func handleHub(_ e: HubEvent, side: Side) {
        for (id, w) in hubWaiters where w.match(e) {
            w.resolve(e)
            hubWaiters[id] = nil
        }
        if case let .input(ev) = e {
            if ev.gesture == .systemExit || ev.gesture == .abnormalExit {
                pageAlive = false
                micOn = false
            }
            // Both lenses can report the same gesture; drop the echo from the other lens within 250 ms.
            let key = "\(ev.gesture.rawValue)|\(ev.source.rawValue)|\(ev.via.rawValue)|\(ev.containerId.map(String.init) ?? "")"
            let now = Date()
            if let l = lastInput, l.key == key, l.side != side, now.timeIntervalSince(l.at) < 0.25 { return }
            lastInput = (key, side, now)
            for h in Array(inputHandlers.values) { h(ev) }
        }
        if case .ringActivity = e {
            ringActivityCount += 1
            log("input: ring activity marker (ring Sys event without a type; also delivered as a tap) from \(tag(side))")
        }
        if case .pageClosed = e {
            pageAlive = false
            micOn = false
        }
        if case let .result(_, code, _, _) = e, code == HubResult.textFailed {
            pageAlive = false
            micOn = false
        }
        emit(.hub(e))
    }

    private func onAudio(_ data: [UInt8], side: Side) {
        guard dedupe.accept(data) else { return }
        let frames = splitAudioPacket(data)
        var pcm: [UInt8]?
        if let lc3 = opt.lc3 { pcm = pcmToBytes(frames.flatMap { lc3.decodeFrame($0) }) }
        let chunk = AudioChunk(lc3Frames: frames, pcm: pcm, side: side, raw: data)
        for h in Array(audioHandlers.values) { h(chunk) }
    }

    public func close() {
        guard !closed else { return }
        closed = true
        heartbeatTask?.cancel()
        contentionTask?.cancel()
        for w in hubWaiters.values { w.resolve(nil) }
        hubWaiters.removeAll()
        for w in authWaiters.values { w.resolve(nil) }
        authWaiters.removeAll()
        for u in unsubs { u() }
        left.disconnect()
        right.disconnect()
    }
}
