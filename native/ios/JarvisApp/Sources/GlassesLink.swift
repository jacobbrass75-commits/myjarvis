import CoreBluetooth
import Foundation
import G2Kit

/// Owns the Bluetooth side: scanning for the two lenses, connecting, the G2Driver session, battery,
/// reconnecting to the last pair, and asking the glasses to link the R1 ring.
@MainActor
final class GlassesLink: ObservableObject {
    enum LensState: String {
        case idle = "not connected", seen = "seen", connecting = "connecting", connected = "connected"
        case unauthenticated = "connected (not authenticated)", authenticated = "authenticated", failed = "failed"
    }

    struct Lens: Identifiable, Equatable {
        var id: String { advert.id }
        var advert: Advertisement
        var side: Side
        var mac: String?
        var serial: String?
    }

    #if targetEnvironment(simulator)
    static let isSimulator = true
    #else
    static let isSimulator = false
    #endif

    /// The whole attempt (both arms, discovery, handshake) must finish within this time.
    static let connectDeadlineSeconds = 30
    /// How long "Find ring" (and the automatic search after the pair is found) listens for the ring.
    static let ringSearchSeconds = 20
    /// connStatus 22 re-sends of RING_CONNECT_INFO: at most one per 10 s, 3 per session.
    static let ringRebindInterval: TimeInterval = 10
    static let maxRingRebinds = 3

    @Published private(set) var bleState: CBManagerState = .unknown
    @Published private(set) var scanning = false
    @Published private(set) var lenses: [Lens] = []
    @Published private(set) var pair: G2Pair?
    @Published private(set) var state: [Side: LensState] = [.left: .idle, .right: .idle]
    /// Per-arm outcome of the last failed attempt, e.g. "discovery: missing characteristic 5401 …".
    @Published private(set) var armDetail: [Side: String] = [:]
    @Published private(set) var device = DeviceInfo()
    @Published private(set) var busy = false
    @Published private(set) var lastError: String?

    // R1 ring (stored in UserDefaults: ring.mac raw hex, ring.name, ring.uuid).
    @Published private(set) var ringName: String?
    /// Ring MAC in RAW advertisement order (the last 6 bytes of its full manufacturer data).
    @Published private(set) var ringMacRaw: [UInt8]?
    @Published private(set) var ringId: String?
    /// Last ring status the glasses reported (RING_CONNECT_INFO / DISCONNECT_INFO / UNPAIR_INFO reply).
    @Published private(set) var ringStatus: RingStatus?
    @Published private(set) var ringStatusAt: Date?
    /// Input events with source = ring, and ring activity markers, since launch.
    @Published private(set) var ringEvents = 0
    @Published private(set) var ringMarkers = 0
    @Published private(set) var ringSearching = false
    /// The direct phone -> ring handoff (fallback) is running / its last outcome.
    @Published private(set) var ringHandoffRunning = false
    @Published private(set) var ringHandoffStatus: String?

    private(set) var driver: G2Driver?
    private var central: G2Central?
    private var finder = PairFinder()
    private var userDisconnected = false
    private var batteryTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var scanTimeoutTask: Task<Void, Never>?
    private var scanID: UUID?
    private var connectionGeneration = 0
    /// The attempt the 30 s deadline cancelled (its error text says so).
    private var timedOutAttempt: Int?
    private var ringSearchTask: Task<Void, Never>?
    /// "Find ring" replaces the stored ring with the first one seen; the automatic search does not.
    private var ringSearchReplaces = false
    private var lastAutoRingSearch: Date?
    private var otherRingsLogged: Set<String> = []
    /// Adverts whose manufacturer bytes failed the name check (logged once per ring per scan).
    private var badRingAdvertsLogged: Set<String> = []
    private var dropBadRingMac: String?
    private var ringBindTask: Task<Void, Never>?
    private var ringRebindTask: Task<Void, Never>?
    private var ringRebinds = 0
    private var ringRebindLimitLogged = false
    private var ringLastSent: Date?
    private let settings: AppSettings
    private let lc3 = Liblc3Decoder()

    /// Called on the main actor for every input event (temple or ring, relayed by the glasses).
    var onInput: ((InputEvent) -> Void)?
    /// Decoded mic audio (s16le, 16 kHz mono), 50 ms per call.
    var onAudio: (([UInt8]) -> Void)?
    /// A new driver session is up: the page must be re-created on the lenses.
    var onSession: ((G2Driver) -> Void)?
    var onDevice: ((DeviceInfo) -> Void)?
    /// The firmware closed our page (double-tap exit, system exit).
    var onPageClosed: (() -> Void)?

    var connected: Bool { driver != nil }
    var canConfirmListedArms: Bool {
        !busy && driver == nil && pair == nil && finder.pairRequiringConfirmation != nil
    }
    var canLinkRing: Bool { driver != nil && ringMacRaw != nil }
    var canHandOffRing: Bool { driver != nil && !ringHandoffRunning && !ringSearching }

    private let d = UserDefaults.standard
    private var savedIds: [Side: UUID] {
        get {
            var out: [Side: UUID] = [:]
            for s in Side.allCases { if let v = d.string(forKey: "lens.\(s.rawValue)"), let u = UUID(uuidString: v) { out[s] = u } }
            return out
        }
        set {
            for s in Side.allCases { d.set(newValue[s]?.uuidString, forKey: "lens.\(s.rawValue)") }
        }
    }

    var hasSavedPair: Bool { savedIds.count == 2 }

    init(settings: AppSettings) {
        self.settings = settings
        if let m = d.string(forKey: "ring.mac"), m.count == 12, m.allSatisfy(\.isHexDigit) { ringMacRaw = fromHex(m) }
        ringName = d.string(forKey: "ring.name")
        ringId = d.string(forKey: "ring.uuid")
        // Older builds stored whatever the last 6 manufacturer bytes were, even when they did not match
        // the ring's name ("EVEN R1_C7D8E9" must end in C7 D8 E9). Never send such a MAC to the glasses.
        if let raw = ringMacRaw, RingAdvert(id: "", name: ringName ?? "", manufacturerData: [], macRaw: raw).nameCheck == .mismatch {
            dropBadRingMac = "\(ringName ?? "ring") raw \(raw.map { String(format: "%02X", $0) }.joined(separator: " "))"
            ringMacRaw = nil
            d.removeObject(forKey: "ring.mac")
        }
    }

    /// Create the CBCentralManager (this triggers the Bluetooth permission prompt).
    func start() {
        guard central == nil else { return }
        let c = G2Central(restoreIdentifier: "jarvis.g2.central")
        c.onState = { [weak self] s in self?.stateChanged(s) }
        c.onAdvert = { [weak self] a in self?.saw(a) }
        c.onRing = { [weak self] r in self?.sawRing(r) }
        // G2Kit diagnostics carry their own prefix (ble:, ring:); log them as they are.
        c.onDiagnostic = { message in log(message) }
        c.onRestore = { ps in log("restored \(ps.count) peripheral(s) after relaunch") }
        PairFinder.log = { line in MainActor.assumeIsolated { log(line) } }
        central = c
        if let mac = ringMacText { log("ring: stored \(ringName ?? "ring") mac \(mac)") }
        if let bad = dropBadRingMac { log("ring: dropped a stored MAC that does not match the ring's name (\(bad))") }
    }

    /// The glasses serial for the SDK's device info. A pair recovered from iOS has no advert serial, so
    /// fall back to either arm's remembered manufacturer data.
    var glassesSerial: String {
        if let p = pair, !p.serial.isEmpty { return p.serial }
        // Reconnecting to saved glasses skips pairing, so `pair` can be nil: use the saved arm ids.
        let ids = pair.map { [$0.left.advert.id, $0.right.advert.id] } ?? [savedIds[.left], savedIds[.right]].compactMap { $0?.uuidString }
        for id in ids {
            let cached = UUID(uuidString: id).flatMap { central?.cachedAdvert($0)?.manufacturerData }
            if let serial = parseG2Manufacturer(cached ?? G2IdentityStore.load(id)).serial { return serial }
        }
        return ""
    }

    var bleStatusText: String {
        if Self.isSimulator { return "The iOS Simulator has no Bluetooth LE. Connect from a real iPhone; the lens preview on the Jarvis tab still works here." }
        return "Bluetooth: \(bleState.label)"
    }

    /// The stored ring MAC as normally printed (the name check picks the byte order) and its raw bytes.
    var ringMacText: String? {
        guard let raw = ringMacRaw, raw.count == 6 else { return nil }
        let ring = RingAdvert(id: ringId ?? "", name: ringName ?? "", manufacturerData: [], macRaw: raw)
        return "\(ring.mac ?? formatMac(raw)) (raw \(raw.map { String(format: "%02X", $0) }.joined(separator: " ")))"
    }

    var ringStatusText: String {
        guard let s = ringStatus else { return "No ring status from the glasses yet" }
        let at = ringStatusAt.map { " at \($0.formatted(date: .omitted, time: .standard))" } ?? ""
        return "Glasses report\(at): \(s.summary)"
    }

    private func stateChanged(_ s: CBManagerState) {
        bleState = s
        log("Bluetooth \(s.label)")
        if s == .poweredOn, settings.autoConnect, driver == nil, hasSavedPair { Task { await reconnectSaved() } }
        // `-autoScan YES` (launch argument, for remote debugging): scan and connect without a tap.
        else if s == .poweredOn, UserDefaults.standard.bool(forKey: "autoScan"), driver == nil, !scanning {
            log("autoScan: starting scan")
            startScan()
        }
        if s != .poweredOn {
            endRingSearch(nil)
            stopScan()
            teardown()
        }
    }

    // MARK: scanning

    func startScan() {
        start()
        guard !busy, driver == nil else { return }
        guard let central, bleState == .poweredOn else {
            lastError = bleStatusText
            return
        }
        stopScan()
        reconnectTask?.cancel()
        reconnectTask = nil
        lastError = nil
        armDetail = [:]
        userDisconnected = false
        state = [.left: .idle, .right: .idle]
        finder = PairFinder()
        lenses.removeAll()
        pair = nil
        // Arms iOS (or another app) already holds never advertise. When both saved arms are among them,
        // connect to them directly instead of waiting for a pair match.
        let saved = savedIds
        if let l = saved[.left], let r = saved[.right] {
            let held = Set(central.retrieveConnectedLenses().map(\.identifier))
            if held.contains(l), held.contains(r) {
                log("both saved arms are connected to iOS (L \(l.uuidString.prefix(8)), R \(r.uuidString.prefix(8))): reconnecting to them directly")
                Task { await reconnectSaved() }
                return
            }
        }
        let id = UUID()
        scanID = id
        scanning = true
        log("scanning for G2 lenses")
        // Recovery can synchronously return both arms and stop the scan. While the scan runs, G2Central
        // re-polls the arms iOS holds every 2 s and sends new ones to onAdvert (.systemConnected).
        central.startScan()
        guard scanning else { return }
        scanTimeoutTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            guard let self, self.scanning, self.scanID == id else { return }
            self.stopScan()
            if self.pair == nil {
                let sides = Set(self.lenses.map(\.side))
                if sides.count == 1, let side = sides.first {
                    self.lastError = "Only the \(side.rawValue) arm was found. Close the Even app, wake the glasses, and retry."
                } else if sides.count == 2 {
                    self.lastError = "Both sides were found but could not be matched to the same glasses. See Log for the identification details."
                } else {
                    self.lastError = "No G2 arms were found. Keep Jarvis open, wake the glasses, and retry."
                }
                log(self.lastError ?? "scan ended")
            }
        }
    }

    func stopScan() {
        scanTimeoutTask?.cancel()
        scanTimeoutTask = nil
        scanID = nil
        scanning = false
        // A ring search keeps the radio scanning until it ends.
        if !ringSearching { central?.stopScan() }
    }

    private func saw(_ a: Advertisement) {
        guard scanning, !busy, driver == nil else { return }
        guard let side = sideFromName(a.name) else { return }
        let (serial, mac) = parseG2Manufacturer(a.manufacturerData)
        let lens = Lens(advert: a, side: side, mac: mac, serial: serial)
        if let i = lenses.firstIndex(where: { $0.id == a.id }) { lenses[i] = lens } else {
            lenses.append(lens)
            log("saw \(a.name) rssi \(a.rssi ?? 0)\(mac.map { " mac \($0)" } ?? "")\(a.source == .systemConnected ? " (held by iOS or another app)" : "")")
        }
        if state[side] == .idle { state[side] = .seen }
        if pair == nil, let p = finder.add(a) {
            pair = p
            log("found pair \(p.serial)")
            // Keep the radio listening for the ring when we do not know its MAC yet.
            autoRingSearchIfNeeded()
            stopScan()
            Task { await connect(p) }
        }
    }

    // MARK: R1 ring

    /// "Find ring": listen for an R1 advert for 20 s and store the first ring seen (replacing the stored one).
    func findRing() {
        start()
        guard central != nil, bleState == .poweredOn else {
            lastError = bleStatusText
            return
        }
        otherRingsLogged.removeAll()
        badRingAdvertsLogged.removeAll()
        startRingSearch(replace: true, why: "Find ring")
    }

    /// "Link ring to glasses": send RING_CONNECT_INFO now, outside the automatic limits.
    func linkRing() {
        guard let drv = driver else { return }
        Task { await sendRingBind(drv, reason: "Link ring to glasses tapped") }
    }

    /// Fallback when "Link ring to glasses" gives no linked status and no ring events: connect to the
    /// ring directly, tell it to link to the RIGHT arm (pair_auth, system_time, adv_start), then send
    /// RING_CONNECT_INFO 1 s later and drop the phone -> ring link 0.5 s after that (workbench Tri-Sync).
    func handOffRing() {
        guard let drv = driver, canHandOffRing else { return }
        Task { await runRingHandoff(drv) }
    }

    private func runRingHandoff(_ drv: G2Driver) async {
        guard let central, !ringHandoffRunning else { return }
        // adv_start carries the right arm's MAC in raw advert order (manufacturer bytes 14..19).
        guard let rightId = UUID(uuidString: drv.right.id),
              let glassesMac = g2MacRaw(fromManufacturer: central.cachedAdvert(rightId)?.manufacturerData ?? G2IdentityStore.load(rightId.uuidString)) else {
            ringHandoffStatus = "Right-arm MAC unknown: scan once with the Even app closed so the right arm advertises."
            log("ring: cannot hand off: right-arm MAC unknown (never seen advertising)")
            return
        }
        // A wrong MAC would point the ring at glasses that do not exist (it then needs the Even app to
        // re-pair), so the arm's name must confirm it.
        let rightName = [drv.right.name, central.cachedAdvert(rightId)?.name].compactMap { $0 }.first { g2MacMatchesName(glassesMac, name: $0) != nil }
        guard let rightName, g2MacMatchesName(glassesMac, name: rightName) == true else {
            ringHandoffStatus = "The right arm's stored MAC does not match its name; not handing off."
            log("ring: cannot hand off: right-arm MAC \(formatMac(glassesMac)) (raw) \(rightName.map { "does not match \($0)" } ?? "cannot be checked against \(drv.right.name)")")
            return
        }
        let held = central.connectedRings()
        guard let ringUUID = ringId.flatMap(UUID.init(uuidString:)) ?? (held.count == 1 ? held.first?.identifier : nil) else {
            ringHandoffStatus = "No ring stored. Tap Find ring with the Even app closed, then tap the ring."
            log("ring: cannot hand off: no ring stored (\(held.count) ring(s) held by iOS); tap Find ring first")
            return
        }
        ringHandoffRunning = true
        ringHandoffStatus = "Handing off…"
        defer { ringHandoffRunning = false }
        log("ring: handoff to R \(formatMac(glassesMac)) (raw) via \(ringName ?? "ring") id \(ringUUID.uuidString.prefix(8))")
        var lens: CBLens?
        do {
            let ring = try await central.connectRing(id: ringUUID, name: ringName)
            lens = ring
            let result = try await R1Handoff.run(ring: ring, glassesMacRaw: glassesMac, log: { m in log(m) })
            ringHandoffStatus = "pair_auth \(result.pairAuth), adv_start \(result.advStart)\(result.accepted ? "" : " (an earlier link may still work)")"
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if driver === drv { await sendRingBind(drv, reason: "1 s after the ring handoff") }
            try? await Task.sleep(nanoseconds: 500_000_000)
        } catch {
            ringHandoffStatus = "Handoff failed: \(describeBleError(error))"
            log("ring: handoff failed: \(describeBleError(error))")
        }
        if let lens {
            lens.disconnect()
            log("ring: released the phone → ring link (the glasses own the ring now)")
        }
    }

    private func autoRingSearchIfNeeded() {
        guard ringMacRaw == nil, !ringSearching, bleState == .poweredOn else { return }
        // Reconnect loops must not keep the radio scanning forever.
        if let last = lastAutoRingSearch, Date().timeIntervalSince(last) < 120 { return }
        lastAutoRingSearch = Date()
        startRingSearch(replace: false, why: "no ring MAC stored; keeps scanning after the glasses pair was found")
    }

    private func startRingSearch(replace: Bool, why: String) {
        guard let central, bleState == .poweredOn else { return }
        ringSearchTask?.cancel()
        ringSearchReplaces = replace || (ringSearching && ringSearchReplaces)
        ringSearching = true
        let seconds = Self.ringSearchSeconds
        log("ring: looking for an EVEN R1 advert for \(seconds) s (\(why))")
        if !central.isScanning { central.startScan() }
        ringSearchTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000) } catch { return }
            guard let self, self.ringSearching else { return }
            let kept = self.ringMacRaw == nil ? "" : "; keeping the stored \(self.ringName ?? "ring")"
            self.endRingSearch("ring: no EVEN R1 advert in \(seconds) s (asleep, or the Even app holds it)\(kept)")
        }
    }

    private func endRingSearch(_ outcome: String?) {
        ringSearchTask?.cancel()
        ringSearchTask = nil
        guard ringSearching else { return }
        ringSearching = false
        ringSearchReplaces = false
        if let outcome { log(outcome) }
        if !scanning { central?.stopScan() }
    }

    /// Every sighting of an R1 advert (G2Central logs the `ring: seen …` line once per scan).
    private func sawRing(_ r: RingAdvert) {
        guard let mac = r.macRaw, mac.count == 6 else { return }
        // A ring's scan response can carry other manufacturer bytes (seen: ASCII "080032"). Only a MAC whose
        // bytes end in the name's 3-byte suffix is the ring's; anything else would re-point the glasses. A
        // name without a suffix ("BCL60…") cannot confirm anything, so its bytes are never stored either.
        guard r.nameCheck.verified else {
            if badRingAdvertsLogged.insert(r.id).inserted {
                let why = r.nameCheck == .mismatch ? "last 6 bytes do not match the name" : "the name has no R1_ suffix to check them against"
                log("ring: ignoring \(r.name) manufacturer data \(hex(r.manufacturerData)) (\(why))")
            }
            return
        }
        if mac == ringMacRaw {
            if ringId != r.id || ringName != r.name { storeRing(mac: mac, name: r.name, id: r.id) }
            if ringSearching { endRingSearch("ring: found the stored ring \(r.name) (rssi \(r.rssi.map(String.init) ?? "?"))") }
            return
        }
        // The automatic search (no MAC stored) only takes the ring these glasses already know by name or
        // CoreBluetooth id; another person's R1 nearby passes the name check too. Find ring (replace) takes any.
        let replacing = ringSearching && ringSearchReplaces
        if ringMacRaw == nil, !replacing, let known = ringName ?? ringId,
           r.name.caseInsensitiveCompare(ringName ?? "") != .orderedSame, r.id != ringId {
            if otherRingsLogged.insert(r.id).inserted {
                log("ring: also seen \(r.name) id \(r.id.prefix(8)); not ours (expecting \(known)), ignored (Find ring takes any ring)")
            }
            return
        }
        guard ringMacRaw == nil || replacing else {
            if otherRingsLogged.insert(r.id).inserted {
                log("ring: also seen \(r.name) id \(r.id.prefix(8)); keeping the stored \(ringName ?? "ring") (Find ring replaces it)")
            }
            return
        }
        let replaced = ringMacRaw != nil
        storeRing(mac: mac, name: r.name, id: r.id)
        log("ring: stored \(r.name) mac \(ringMacText ?? "?") id \(r.id.prefix(8)) name-check \(r.nameCheck.rawValue)\(replaced ? " (replaced the previous ring)" : "")")
        endRingSearch(nil)
        // Only Find ring (the user asked to link this ring) sends it; an automatic find just remembers the MAC.
        if let drv = driver, replacing { scheduleRingBind(drv, afterMs: 500, reason: "Find ring") }
    }

    private func storeRing(mac: [UInt8], name: String?, id: String?) {
        ringMacRaw = mac
        ringName = name
        ringId = id
        d.set(hex(mac), forKey: "ring.mac")
        d.set(name, forKey: "ring.name")
        d.set(id, forKey: "ring.uuid")
    }

    /// The glasses keep their own ring link (paired once in the Even app) and relay its gestures, so a
    /// session does not re-send RING_CONNECT_INFO. It goes out only when the user taps Link ring / Find ring
    /// or the glasses report the ring disconnected (connStatus 22). The ring MAC byte order the glasses
    /// expect is still unproven on hardware, so sending it unasked could only break a working link.
    private func scheduleSessionRingBind(_ drv: G2Driver) {
        if let mac = ringMacText {
            log("ring: \(ringName ?? "ring") mac \(mac) on file; not re-sent at connect (the glasses keep their own ring link)")
        }
    }

    private func scheduleRingBind(_ drv: G2Driver, afterMs: Int, reason: String) {
        ringBindTask?.cancel()
        ringBindTask = Task { [weak self, weak drv] in
            do { try await Task.sleep(nanoseconds: UInt64(afterMs) * 1_000_000) } catch { return }
            guard let self, let drv, self.driver === drv else { return }
            self.ringBindTask = nil
            await self.sendRingBind(drv, reason: reason)
        }
    }

    private func sendRingBind(_ drv: G2Driver, reason: String) async {
        guard let mac = ringMacRaw else {
            log("ring: no verified ring MAC, RING_CONNECT_INFO not sent (\(reason)); a ring already paired to these glasses still works through them")
            return
        }
        log("ring: sending RING_CONNECT_INFO (\(reason))")
        ringLastSent = Date()
        do {
            try await drv.bindRing(macRaw: mac, connect: true, ringName: ringName)
        } catch {
            log("ring: RING_CONNECT_INFO failed: \(describeBleError(error))")
        }
    }

    private func handleRingStatus(_ s: RingStatus, _ drv: G2Driver) {
        // Both arms acknowledge RING_CONNECT_INFO with an empty reply; it must not hide a real status.
        if !s.isAckOnly || ringStatus == nil {
            ringStatus = s
            ringStatusAt = Date()
        }
        // The glasses' RingInfo carries the MAC (field 5.2): learn it if no advert gave us one, unless it
        // contradicts the ring's name (the glasses may echo a wrong MAC an older build sent them).
        if ringMacRaw == nil, let mac = s.macRaw, mac.count == 6 {
            if let learned = s.learnableMac(ringName: ringName) {
                storeRing(mac: learned, name: ringName, id: ringId)
                log("ring: learned the ring MAC \(ringMacText ?? "?") from the glasses' status")
            } else if s.cmd == RingCmd.connectInfo {
                log("ring: not storing mac \(formatMac(mac)) (raw) from the glasses' status: it does not match \(ringName ?? "the ring's name")")
            }
        }
        if s.linked {
            ringRebindTask?.cancel()
            ringRebindTask = nil
        } else if s.needsRebind {
            scheduleRebind(drv)
        }
    }

    /// connStatus 22: the glasses lost the ring. Re-send RING_CONNECT_INFO (MentraOS), at most once per
    /// 10 s and 3 times per session; a report inside the 10 s window waits for it instead of being dropped.
    private func scheduleRebind(_ drv: G2Driver) {
        guard ringRebindTask == nil, ringMacRaw != nil else { return }
        guard ringRebinds < Self.maxRingRebinds else {
            if !ringRebindLimitLogged {
                ringRebindLimitLogged = true
                log("ring: glasses still report connStatus 22 after \(Self.maxRingRebinds) re-sends; not re-sending again this session (Link ring to glasses retries)")
            }
            return
        }
        ringRebinds += 1
        let n = ringRebinds, limit = Self.maxRingRebinds
        let wait = ringLastSent.map { max(0, Self.ringRebindInterval - Date().timeIntervalSince($0)) } ?? 0
        log("ring: glasses report the ring disconnected (connStatus 22); re-sending RING_CONNECT_INFO \(n)/\(limit)\(wait >= 0.5 ? " in \(Int(wait.rounded())) s" : "")")
        ringRebindTask = Task { [weak self, weak drv] in
            if wait > 0 { do { try await Task.sleep(nanoseconds: UInt64(wait * 1e9)) } catch { return } }
            guard let self, let drv, self.driver === drv else { return }
            self.ringRebindTask = nil
            await self.sendRingBind(drv, reason: "re-send \(n)/\(limit) after connStatus 22")
        }
    }

    private func resetRingSession() {
        ringBindTask?.cancel()
        ringBindTask = nil
        ringRebindTask?.cancel()
        ringRebindTask = nil
        ringRebinds = 0
        ringRebindLimitLogged = false
        ringLastSent = nil
    }

    // MARK: connecting

    func connect(_ p: G2Pair) async {
        guard !busy, driver == nil else { return }
        guard let l = UUID(uuidString: p.left.advert.id), let r = UUID(uuidString: p.right.advert.id) else { return }
        pair = p
        await connect(left: l, right: r, leftName: p.left.advert.name, rightName: p.right.advert.name)
    }

    /// System-connected arms may have no advertising serial. The user must explicitly identify
    /// the single visible pair before connecting; conflicting or ambiguous identities are excluded.
    func connectListedArms() async {
        guard canConfirmListedArms, let p = finder.pairRequiringConfirmation else { return }
        log("user confirmed the listed left and right arms")
        await connect(p)
    }

    func reconnectSaved() async {
        start()
        let ids = savedIds
        guard let l = ids[.left], let r = ids[.right] else { return }
        log("reconnecting to saved glasses")
        await connect(left: l, right: r, leftName: nil, rightName: nil)
    }

    private func connect(left: UUID, right: UUID, leftName: String?, rightName: String?) async {
        guard let central, !busy, driver == nil else { return }
        autoRingSearchIfNeeded()
        stopScan()
        reconnectTask?.cancel()
        reconnectTask = nil
        connectionGeneration += 1
        let attempt = connectionGeneration
        busy = true
        userDisconnected = false
        lastError = nil
        armDetail = [:]
        defer { if attempt == connectionGeneration { busy = false } }
        // Each step has its own timeout; this caps the whole attempt. Cancelling the links makes every
        // pending step fail, so the per-arm results still say how far each arm got.
        let deadlineSeconds = Self.connectDeadlineSeconds
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(deadlineSeconds) * 1_000_000_000) } catch { return }
            guard let self, attempt == self.connectionGeneration, self.busy, self.driver == nil else { return }
            self.timedOutAttempt = attempt
            log("connect: no result in \(deadlineSeconds) s (left \(self.state[.left]?.rawValue ?? "?"), right \(self.state[.right]?.rawValue ?? "?")); cancelling the attempt")
            central.cancelConnections()
        }
        defer { deadline.cancel() }
        do {
            let opts = DriverOptions(imageFlowControl: settings.fastImages, imageWindow: settings.fastImages ? 2 : 1,
                                     dashboardPrelude: settings.dashboardPrelude, pipeRole: settings.pipeRole,
                                     phoneType: PhoneType.ios, sessionInit: settings.sessionInit, lc3: lc3,
                                     log: { m in log(m.hasPrefix("ring:") || m.hasPrefix("input:") ? m : "g2: \(m)") })
            // Both arms connect and discover concurrently; one failing never stops the other being tried.
            let drv = try await connectG2Pair(left: {
                try await self.acquire(.left, id: left, name: leftName, attempt: attempt, central: central)
            }, right: {
                try await self.acquire(.right, id: right, name: rightName, attempt: attempt, central: central)
            }, attach: { L, R in
                guard attempt == self.connectionGeneration, !self.userDisconnected else { throw CancellationError() }
                log("connected L=\(L.name) R=\(R.name), max write \(R.maxWriteWithoutResponse) bytes")
                if R.maxWriteWithoutResponse < 244 { log("warning: MTU too small for 244-byte packets (\(R.maxWriteWithoutResponse))") }
                return try await G2Driver.attach(left: L, right: R, options: opts)
            })
            guard attempt == connectionGeneration, !userDisconnected else {
                drv.close()
                return
            }
            savedIds = [.left: left, .right: right]
            rememberIdentity(left: left, right: right, central: central)
            driver = drv
            resetRingSession()
            wire(drv)
            for side in Side.allCases { state[side] = drv.authenticated[side] == true ? .authenticated : .unauthenticated }
            onSession?(drv)
            scheduleSessionRingBind(drv)
            batteryTask = Task { [weak self] in
                while !Task.isCancelled {
                    if let info = try? await self?.driver?.requestDeviceInfo() { self?.device = info }
                    try? await Task.sleep(nanoseconds: 60_000_000_000)
                }
            }
        } catch {
            guard attempt == connectionGeneration, !userDisconnected else { return }
            let timedOut = timedOutAttempt == attempt
            let pairError = error as? PairConnectError
            let detail = pairError.map(\.description) ?? describeBleError(error)
            log("connect failed: \(detail)\(timedOut ? " (\(deadlineSeconds) s deadline)" : "")")
            teardown()
            var text = pairError == nil ? "Connect failed: \(detail)" : "Could not connect both arms. \(detail)"
            if timedOut { text = "Timed out after \(deadlineSeconds) s. " + text }
            lastError = text
            if let pairError {
                for side in Side.allCases {
                    if let e = pairError.error(side) {
                        state[side] = .failed
                        armDetail[side] = describeBleError(e)
                    } else {
                        armDetail[side] = "connected, then released because the other arm failed"
                    }
                }
            }
            scheduleReconnect()
        }
    }

    /// Connect and discover one arm, keeping its row in the UI current.
    private func acquire(_ side: Side, id: UUID, name: String?, attempt: Int, central: G2Central) async throws -> CBLens {
        guard attempt == connectionGeneration, !userDisconnected else { throw CancellationError() }
        state[side] = .connecting
        do {
            let lens = try await central.connect(id: id, name: name)
            guard attempt == connectionGeneration, !userDisconnected else {
                lens.disconnect()
                throw CancellationError()
            }
            state[side] = .connected
            return lens
        } catch {
            if attempt == connectionGeneration, !userDisconnected, !(error is CancellationError) {
                state[side] = .failed
                armDetail[side] = describeBleError(error)
            }
            throw error
        }
    }

    /// Keep each arm's manufacturer data (serial + MAC) so it is still identifiable when iOS or another
    /// app holds it and it stops advertising.
    private func rememberIdentity(left: UUID, right: UUID, central: G2Central) {
        var parts: [String] = []
        for (side, id) in [(Side.left, left), (Side.right, right)] {
            let data = central.cachedAdvert(id)?.manufacturerData
            let (serial, mac) = parseG2Manufacturer(data)
            let saved = G2IdentityStore.save(data, for: id.uuidString)
            let stored = saved ? "saved" : serial == nil ? "none" : "already saved"
            parts.append("\(side == .left ? "L" : "R")=\(id.uuidString.prefix(8)) serial \(serial ?? "?") mac \(mac ?? "?") identity \(stored)")
        }
        log("pair connected: \(parts.joined(separator: " · "))")
    }

    private func wire(_ drv: G2Driver) {
        drv.onInput { [weak self] e in
            guard let self else { return }
            log("input: \(e.gesture.rawValue) source=\(e.source.rawValue) via=\(e.via.rawValue)\(e.containerId.map { " container=\($0)" } ?? "")\(e.itemIndex.map { " item=\($0)" } ?? "")")
            if e.source == .ring { self.ringEvents += 1 }
            self.onInput?(e)
        }
        drv.onAudioData { [weak self] chunk in if let pcm = chunk.pcm { self?.onAudio?(pcm) } }
        drv.onEvent { [weak self, weak drv] e in
            guard let self, let drv, self.driver === drv else { return }
            switch e {
            case .authenticated(let side, let ok):
                self.state[side] = ok ? .authenticated : .unauthenticated
                log("\(side.rawValue) lens auth \(ok ? "ok" : "rejected")")
            case .device(let info):
                self.device = info
                self.onDevice?(info)
            case .disconnected(let side):
                log("\(side.rawValue) lens disconnected")
                self.teardown()
                self.scheduleReconnect()
            case .ring(let status):
                self.handleRingStatus(status, drv)
            case .hub(let h):
                switch h {
                case .pageClosed:
                    self.onPageClosed?()
                case .input(let ev) where ev.gesture == .systemExit || ev.gesture == .abnormalExit:
                    self.onPageClosed?()
                case .ringActivity:
                    self.ringMarkers += 1
                default: break
                }
            }
        }
    }

    func disconnect() {
        userDisconnected = true
        stopScan()
        teardown()
        log("disconnected by user")
    }

    func forget() {
        disconnect()
        savedIds = [:]
        lenses.removeAll()
        pair = nil
        finder = PairFinder()
    }

    private func teardown() {
        connectionGeneration += 1
        busy = false
        reconnectTask?.cancel()
        reconnectTask = nil
        batteryTask?.cancel()
        batteryTask = nil
        resetRingSession()
        let d = driver
        driver = nil
        d?.close()
        central?.cancelConnections()
        state = [.left: .idle, .right: .idle]
    }

    private func scheduleReconnect() {
        guard !userDisconnected, settings.autoConnect, hasSavedPair else { return }
        reconnectTask?.cancel()
        let generation = connectionGeneration
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            guard let self, generation == self.connectionGeneration, !self.userDisconnected,
                  self.settings.autoConnect, !self.scanning, !self.busy,
                  self.driver == nil, self.bleState == .poweredOn else { return }
            self.reconnectTask = nil
            await self.reconnectSaved()
        }
    }
}
