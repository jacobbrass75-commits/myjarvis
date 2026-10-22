// CoreBluetooth transport: scan for the two lenses, connect, discover their GATT table, and expose each
// lens as a `BlePeripheral` for G2Driver.
//
// iOS specifics (README "CoreBluetooth specifics", MentraOS G2.swift):
//  - writes are .withoutResponse. Most messages are paced by the driver (6 ms between packets). Image
//    packets go as fast as CoreBluetooth takes them: `waitWritable` waits for canSendWriteWithoutResponse
//    (woken by peripheralIsReady, re-checked every 2 ms) but never longer than a few tens of ms, because
//    iOS does not deliver peripheralIsReady(toSendWriteWithoutResponse:) to a backgrounded central and a
//    strictly gated queue would deadlock there.
//  - CoreBluetooth hides MAC addresses; the lens MAC comes from manufacturer data (see Transport.swift).
//  - Discovery walks EVERY service: 5401/5402 sit under …5450 and 6402 under …6450 on current firmware;
//    the advertised …0000 is not their parent (workbench g2_protocol.dart, MentraOS discoverServices(nil)).
//  - Pass a restore identifier to get relaunched for BLE events (needs UIBackgroundModes bluetooth-central).
//
// Diagnostics go to `G2Central.onDiagnostic`, each line carrying its own prefix (ble:, ring:).

#if canImport(CoreBluetooth)
import CoreBluetooth
import Foundation

public enum BleError: Error, CustomStringConvertible {
    case unavailable(String)
    case notFound
    case timeout(String)
    case missingCharacteristic(String)
    case disconnected
    case failed(String)

    public var description: String {
        switch self {
        case .unavailable(let s): return "Bluetooth unavailable: \(s)"
        case .notFound: return "peripheral not found"
        case .timeout(let s): return "timed out: \(s)"
        case .missingCharacteristic(let s): return "missing characteristic \(s)"
        case .disconnected: return "disconnected"
        case .failed(let s): return s
        }
    }
}

extension CBManagerState {
    public var label: String {
        switch self {
        case .poweredOn: return "on"
        case .poweredOff: return "off"
        case .unauthorized: return "not allowed"
        case .unsupported: return "unsupported (the iOS Simulator has no Bluetooth LE)"
        case .resetting: return "resetting"
        case .unknown: return "starting"
        @unknown default: return "unknown"
        }
    }
}

extension CBPeripheralState {
    var label: String {
        switch self {
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .disconnecting: return "disconnecting"
        @unknown default: return "unknown"
        }
    }
}

/// "L"/"R" from the lens name, "ring" for the R1, else the first 8 characters of the identifier.
func lensTag(_ name: String?, _ id: String) -> String {
    if RingAdvert.isRingName(name) { return "ring" }
    switch name.flatMap(sideFromName) {
    case .left: return "L"
    case .right: return "R"
    case nil: return String(id.prefix(8))
    }
}

/// "error=14 (Peer removed pairing information) pairing removed on the other side: re-pair this arm".
func disconnectErrorText(_ error: Error?) -> String {
    guard let error else { return "error=none" }
    let ns = error as NSError
    var hint = ""
    if ns.domain == CBErrorDomain {
        switch ns.code {
        case 6: hint = " connection timed out"
        case 7: hint = " the peripheral disconnected"
        case 14: hint = " pairing removed on the other side: re-pair this arm"
        case 15: hint = " encryption timed out"
        default: break
        }
    }
    return "error=\(ns.code) (\(ns.localizedDescription))\(hint)"
}

fileprivate typealias Gatt = GattCatalog<CBCharacteristic>

/// One lens (or any GATT peripheral) as a `BlePeripheral`.
@MainActor
public final class CBLens: NSObject, BlePeripheral, CBPeripheralDelegate {
    public let peripheral: CBPeripheral
    public nonisolated let id: String
    public let name: String
    /// Characteristics discovery must find: 5401/5402 for a lens, BAE80012 for the ring.
    private let required: [String]
    private var gatt: Gatt
    private var notifyHandlers: [String: ([UInt8]) -> Void] = [:]
    private var disconnectHandlers: [() -> Void] = []
    private var discoverCont: CheckedContinuation<Void, Error>?
    private var discoverTimeout: Task<Void, Never>?
    private var discoverStarted = Date()
    private var notifyConts: [String: CheckedContinuation<Void, Error>] = [:]
    private var notifyTimeouts: [String: Task<Void, Never>] = [:]
    private var disconnected = false
    private(set) var isDiscovered = false
    /// When the last write was issued (the idle time in disconnect logs).
    public private(set) var lastWrite: Date?
    /// Writers waiting for peripheralIsReady(toSendWriteWithoutResponse:).
    private var readyWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    weak var central: G2Central?

    /// Notifications must be enabled within this time; an unanswered iOS pairing prompt stalls it.
    static let subscribeTimeoutSeconds: Double = 5

    init(_ p: CBPeripheral, name: String, required: [String] = GattCatalog<CBCharacteristic>.lensRequired) {
        peripheral = p
        id = p.identifier.uuidString
        self.name = name
        self.required = required
        gatt = Gatt(required: required)
        super.init()
        p.delegate = self
    }

    public var maxWriteWithoutResponse: Int { peripheral.maximumWriteValueLength(for: .withoutResponse) }

    var tag: String { lensTag(name, id) }

    private func log(_ m: String) { central?.onDiagnostic?(m) }

    public func has(_ characteristic: String) -> Bool { gatt.has(characteristic) }

    func discover(timeoutSeconds: Double = 10) async throws {
        guard discoverCont == nil else { throw BleError.failed("Service discovery already in progress") }
        guard !disconnected, peripheral.state == .connected else { throw BleError.disconnected }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            discoverCont = c
            discoverStarted = Date()
            gatt = Gatt(required: required)
            // All services: the characteristics are spread over 5450/6450/7450, not under the advertised UUID.
            peripheral.discoverServices(nil)
            discoverTimeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1e9)) } catch { return }
                guard let self else { return }
                let progress = self.gatt.summary.isEmpty ? "no services listed" : "so far \(self.gatt.summary.joined(separator: " "))"
                self.log("ble: \(self.tag) discovery timed out after \(Int(timeoutSeconds)) s (\(progress))")
                self.finishDiscover(BleError.timeout("service discovery on \(self.name) (\(progress))"))
            }
        }
    }

    private func finishDiscover(_ error: Error?) {
        guard let c = discoverCont else { return }
        discoverCont = nil
        discoverTimeout?.cancel(); discoverTimeout = nil
        isDiscovered = error == nil
        if let error { c.resume(throwing: error) } else { c.resume() }
    }

    public func write(_ characteristic: String, _ data: [UInt8], withoutResponse: Bool) async throws {
        guard !disconnected, peripheral.state == .connected else { throw BleError.disconnected }
        guard let ch = gatt.value(characteristic) else { throw BleError.missingCharacteristic(characteristic) }
        lastWrite = Date()
        peripheral.writeValue(Data(data), for: ch, type: withoutResponse ? .withoutResponse : .withResponse)
    }

    public func waitWritable(timeoutMs: Int) async -> Bool {
        if peripheral.canSendWriteWithoutResponse { return true }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while !disconnected, Date() < deadline {
            await waitReady(maxMs: 2)
            if peripheral.canSendWriteWithoutResponse { return true }
        }
        return false
    }

    /// Until peripheralIsReady or `maxMs`, whichever comes first (resumed exactly once).
    private func waitReady(maxMs: Int) async {
        let id = UUID()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            readyWaiters[id] = c
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(maxMs) * 1_000_000)
                self.readyWaiters.removeValue(forKey: id)?.resume()
            }
        }
    }

    private func wakeWriters() {
        let waiting = readyWaiters
        readyWaiters.removeAll()
        for c in waiting.values { c.resume() }
    }

    public func subscribe(_ characteristic: String, _ onData: @escaping @MainActor ([UInt8]) -> Void) async throws -> @MainActor () -> Void {
        guard !disconnected, peripheral.state == .connected else { throw BleError.disconnected }
        let key = characteristic.uppercased()
        guard let ch = gatt.value(key) else { throw BleError.missingCharacteristic(characteristic) }
        let short = Gatt.short(key)
        // One wait per characteristic: a second one would overwrite (and leak) the first continuation.
        guard notifyConts[key] == nil else { throw BleError.failed("already enabling notifications on \(short) for \(name)") }
        notifyHandlers[key] = onData
        let started = Date()
        do {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                notifyConts[key] = c
                peripheral.setNotifyValue(true, for: ch)
                let seconds = Self.subscribeTimeoutSeconds
                notifyTimeouts[key] = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) } catch { return }
                    guard let self else { return }
                    self.finishNotify(key, BleError.failed(
                        "enabling notifications on \(short) for \(self.name) timed out — accept the iOS pairing prompt if one appeared"))
                }
            }
        } catch {
            notifyHandlers[key] = nil
            log("ble: \(tag) \(short) notify failed: \(describeBleError(error))")
            throw error
        }
        log("ble: \(tag) \(short) notifying (+\(Int(Date().timeIntervalSince(started) * 1000)) ms)")
        return { [weak self] in
            guard let self else { return }
            self.notifyHandlers[key] = nil
            if self.peripheral.state == .connected { self.peripheral.setNotifyValue(false, for: ch) }
        }
    }

    private func finishNotify(_ key: String, _ error: Error?) {
        notifyTimeouts.removeValue(forKey: key)?.cancel()
        guard let c = notifyConts.removeValue(forKey: key) else { return }
        if let error { c.resume(throwing: error) } else { c.resume() }
    }

    public func onDisconnect(_ cb: @escaping @MainActor () -> Void) { disconnectHandlers.append(cb) }

    public func disconnect() { central?.cancel(self) }

    func didDisconnect() {
        guard !disconnected else { return }
        disconnected = true
        isDiscovered = false
        finishDiscover(BleError.disconnected)
        wakeWriters()
        for key in Array(notifyConts.keys) { finishNotify(key, BleError.disconnected) }
        gatt = Gatt(required: required); notifyHandlers.removeAll()
        let handlers = disconnectHandlers
        disconnectHandlers.removeAll()
        for h in handlers { h() }
    }

    private static func propertyLabel(_ p: CBCharacteristicProperties) -> String {
        Gatt.propertyLabel(read: p.contains(.read), write: p.contains(.write),
                                                    writeWithoutResponse: p.contains(.writeWithoutResponse),
                                                    notify: p.contains(.notify), indicate: p.contains(.indicate))
    }

    // MARK: CBPeripheralDelegate (delivered on the main queue)

    public nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            guard !disconnected, discoverCont != nil else { return }
            if let error {
                log("ble: \(tag) service discovery failed: \(describeBleError(error))")
                return finishDiscover(error)
            }
            let services = peripheral.services ?? []
            guard !services.isEmpty else {
                log("ble: \(tag) no GATT services")
                return finishDiscover(BleError.failed("no GATT services on \(name)"))
            }
            gatt.begin(services: services.map(\.uuid.uuidString))
            log("ble: \(tag) services \(services.map { Gatt.short($0.uuid.uuidString, service: true) }.joined(separator: " "))")
            for s in services { peripheral.discoverCharacteristics(nil, for: s) }
        }
    }

    public nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            guard !disconnected, discoverCont != nil else { return }
            let found = (service.characteristics ?? []).map {
                Gatt.Found(uuid: $0.uuid.uuidString, properties: Self.propertyLabel($0.properties), value: $0)
            }
            if let error {
                // One service failing is not fatal: only 5401/5402 are required.
                log("ble: \(tag) characteristics of \(Gatt.short(service.uuid.uuidString, service: true)) failed: \(describeBleError(error)); continuing")
            }
            let complete = gatt.add(service: service.uuid.uuidString, found: error == nil ? found : [], error: error.map(describeBleError))
            guard complete else { return }
            let table = gatt.summary.joined(separator: " ")
            log("ble: \(tag) GATT \(table)")
            let missing = gatt.missing
            guard missing.isEmpty else {
                let names = missing.map { Gatt.short($0) }.joined(separator: " and ")
                return finishDiscover(BleError.missingCharacteristic("\(names) on \(name) (GATT \(table))"))
            }
            log(String(format: "ble: %@ discovered in %.1f s", tag, Date().timeIntervalSince(discoverStarted)))
            finishDiscover(nil)
        }
    }

    public nonisolated func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        MainActor.assumeIsolated {
            guard !disconnected else { return }
            let uuids = invalidatedServices.map(\.uuid.uuidString)
            let listed = uuids.map { Gatt.short($0, service: true) }.joined(separator: " ")
            if discoverCont != nil {
                // Mid-discovery: start over so the round does not wait on services that no longer exist.
                log("ble: \(tag) services changed during discovery (\(listed) invalidated); rediscovering")
                peripheral.discoverServices(nil)
                return
            }
            let dropped = gatt.invalidate(services: uuids)
            isDiscovered = false
            let lost = dropped.isEmpty ? "none" : dropped.map { Gatt.short($0) }.joined(separator: ",")
            let gone = gatt.required.filter { !gatt.has($0) }.map { Gatt.short($0) }
            let broken = gone.isEmpty ? "" : " — \(gone.joined(separator: "/")) gone, writes fail until reconnect"
            log("ble: \(tag) services changed (\(listed) invalidated); cleared characteristics \(lost)\(broken)")
        }
    }

    public nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            finishNotify(characteristic.uuid.uuidString.uppercased(), error)
        }
    }

    public nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard error == nil, let v = characteristic.value else { return }
            notifyHandlers[characteristic.uuid.uuidString.uppercased()]?([UInt8](v))
        }
    }

    public nonisolated func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        MainActor.assumeIsolated { wakeWriters() }
    }
}

/// CBCentralManager wrapper: state, scanning (with G2 pair detection) and connecting.
@MainActor
public final class G2Central: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager!
    private var lenses: [UUID: CBLens] = [:]
    private var connectConts: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var connectAttempts: [UUID: UUID] = [:]
    private var connectTimeouts: [UUID: Task<Void, Never>] = [:]
    private var connectStarted: [UUID: Date] = [:]
    private struct PendingDisconnection {
        let peripheral: CBPeripheral
        let started: Date
    }
    private var disconnecting: [UUID: PendingDisconnection] = [:]
    private var known: [UUID: CBPeripheral] = [:]
    private var adverts: [UUID: Advertisement] = [:]
    /// Where each cached serial came from: "live" (an advert this process saw) or "persisted".
    private var identityOrigin: [UUID: String] = [:]
    private var reportedOthers: Set<UUID> = []
    private var scanActive = false
    private var recoveryPoll: Task<Void, Never>?
    /// Per scan: system-held arms already logged / sent to onAdvert, and rings already logged.
    private var recoveredLogged: Set<UUID> = []
    private var recoveredSent: [UUID: Advertisement] = [:]
    private var ringsLogged: Set<UUID> = []
    /// Rings seen advertising in this process (the `src=` of a ring connect).
    private var ringsSeen: Set<UUID> = []
    public private(set) var state: CBManagerState = .unknown
    public var onState: ((CBManagerState) -> Void)?
    public var onAdvert: ((Advertisement) -> Void)?
    /// Diagnostic lines, each with its own prefix ("ble: …", "ring: …"); log them verbatim.
    public var onDiagnostic: ((String) -> Void)?
    /// Every sighting of an R1 ring advert ("EVEN R1_…" or "BCL60" names).
    public var onRing: ((RingAdvert) -> Void)?
    /// Peripherals iOS handed back after relaunching us for a BLE event (state restoration).
    public var onRestore: (([CBPeripheral]) -> Void)?

    /// How often a running scan re-checks for arms iOS or another app holds (they never advertise).
    static let recoveryPollSeconds: Double = 2

    /// - Parameter restoreIdentifier: enables CoreBluetooth state restoration (iOS only; needs the
    ///   bluetooth-central background mode).
    public init(restoreIdentifier: String? = nil) {
        super.init()
        var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: true]
        #if os(iOS)
        if let restoreIdentifier { options[CBCentralManagerOptionRestoreIdentifierKey] = restoreIdentifier }
        #endif
        manager = CBCentralManager(delegate: self, queue: .main, options: options)
    }

    /// Whether `startScan` is in effect (CBCentralManager.isScanning lags the start/stop calls).
    public var isScanning: Bool { scanActive }

    private func log(_ m: String) { onDiagnostic?(m) }

    private func tag(_ id: UUID, _ name: String? = nil) -> String {
        lensTag(name ?? adverts[id]?.name ?? lenses[id]?.name, id.uuidString)
    }

    /// The latest metadata for a lens (name, manufacturer data incl. persisted serial/MAC, source).
    public func cachedAdvert(_ id: UUID) -> Advertisement? { adverts[id] }

    /// Scan for everything (the lenses are filtered by name; their service UUID is not always advertised).
    /// Arms that iOS or another app already holds do not advertise; they are recovered now and re-polled
    /// every 2 s while the scan runs, and reach `onAdvert` tagged `.systemConnected`.
    public func startScan() {
        guard state == .poweredOn else { return }
        scanActive = true
        recoveredLogged.removeAll(); recoveredSent.removeAll(); ringsLogged.removeAll()
        manager.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        // Created before the first poll so a synchronous recover -> pair -> stopScan path cancels it.
        recoveryPoll?.cancel()
        recoveryPoll = Task { [weak self] in
            while true {
                do { try await Task.sleep(nanoseconds: UInt64(Self.recoveryPollSeconds * 1e9)) } catch { return }
                guard let self, self.scanActive else { return }
                self.pollConnectedLenses()
            }
        }
        let recovered = pollConnectedLenses().compactMap { adverts[$0.identifier] }
        let left = recovered.filter { sideFromName($0.name) == .left }.count
        let right = recovered.filter { sideFromName($0.name) == .right }.count
        let missingSerial = recovered.filter { parseG2Manufacturer($0.manufacturerData).serial == nil }.count
        log("ble: recovered \(recovered.count) connected G2 lenses: left \(left), right \(right), unknown side \(recovered.count - left - right); \(missingSerial) missing serial metadata.")
    }

    /// Unconditional: `manager.isScanning` is still false right after `scanForPeripherals`, so guarding on
    /// it missed the synchronous recover -> pair -> stop path and left the radio scanning.
    public func stopScan() {
        scanActive = false
        recoveryPoll?.cancel(); recoveryPoll = nil
        guard state == .poweredOn else { return }
        manager.stopScan()
    }

    /// Retrieves the arms iOS holds and sends new or changed ones to `onAdvert` (tagged
    /// `.systemConnected`). `startScan` calls this, then every 2 s while scanning. Returns all
    /// recovered G2 lenses.
    @discardableResult
    public func pollConnectedLenses() -> [CBPeripheral] {
        let recovered = retrieveConnectedLenses()
        checkHeldRing()
        for p in recovered {
            guard lenses[p.identifier] == nil, let advert = adverts[p.identifier], sideFromName(advert.name) != nil,
                  recoveredSent[p.identifier] != advert else { continue }
            recoveredSent[p.identifier] = advert
            onAdvert?(advert)
        }
        return recovered
    }

    /// Lenses iOS still holds (e.g. after a process restart, or the Even app's link), as MentraOS does.
    public func retrieveConnectedLenses() -> [CBPeripheral] {
        guard state == .poweredOn else { return [] }
        // Retrieval matches GATT services. 5450/6450 are the real parents of the lens characteristics;
        // …0000 (advertised only) and Nordic UART catch lenses indexed differently.
        let services = [G2UUID.controlService, G2UUID.audioService, G2UUID.advertisedService, G2UUID.nordicUartService]
        var found: [UUID: (peripheral: CBPeripheral, via: String)] = [:]
        for service in services {
            for p in manager.retrieveConnectedPeripherals(withServices: [CBUUID(string: service)]) where found[p.identifier] == nil {
                found[p.identifier] = (p, service == G2UUID.nordicUartService ? "NUS" : Gatt.short(service, service: true))
            }
        }
        var recovered: [CBPeripheral] = []
        for (p, via) in found.values.sorted(by: { $0.peripheral.identifier.uuidString < $1.peripheral.identifier.uuidString }) {
            let id = p.identifier
            // Our own links show up here too; they are not held by anyone else.
            let ours = lenses[id] != nil
            let firstReport = !ours && recoveredLogged.insert(id).inserted
            // Nordic UART is shared by unrelated products. A service match alone is not G2 identity.
            guard let advert = cacheAdvert(p, source: ours ? adverts[id]?.source ?? .advert : .systemConnected) else {
                if firstReport { log("ble: recovered \"\(p.name ?? "?")\" id \(id.uuidString.prefix(8)) via \(via) ignored (not a G2 name)") }
                continue
            }
            known[id] = p
            recovered.append(p)
            guard firstReport else { continue }
            if sideFromName(advert.name) == nil {
                log("ble: recovered \"\(advert.name)\" id \(id.uuidString.prefix(8)) via \(via) ignored (no L/R in name)")
            } else {
                let serial = parseG2Manufacturer(advert.manufacturerData).serial
                log("ble: recovered \"\(advert.name)\" id \(id.uuidString.prefix(8)) via \(via) src=system serial=\(serial ?? "none")\(serial == nil ? "" : " (\(identityOrigin[id] ?? "live"))")")
            }
        }
        return recovered
    }

    /// A ring the Even app (or iOS) holds does not advertise, so its MAC cannot be learned. Say so once per scan.
    private func checkHeldRing() {
        for p in connectedRings() where ringsLogged.insert(p.identifier).inserted {
            log("ring: \(p.name ?? "R1") id \(p.identifier.uuidString.prefix(8)) is connected to iOS (another app holds it?); it will not advertise")
        }
    }

    public func retrieve(_ ids: [UUID]) -> [CBPeripheral] { manager.retrievePeripherals(withIdentifiers: ids) }

    /// Connect a peripheral seen in a scan (by its CoreBluetooth identifier) or retrieved earlier.
    /// Failures are `PhaseError`s naming the phase ("connect" or "discovery").
    public func connect(id: UUID, name: String? = nil, timeoutSeconds: Double = 15) async throws -> CBLens {
        guard state == .poweredOn else { throw PhaseError("connect", BleError.unavailable(state.label)) }
        guard let p = known[id] ?? manager.retrievePeripherals(withIdentifiers: [id]).first else { throw PhaseError("connect", BleError.notFound) }
        return try await connect(p, name: name, timeoutSeconds: timeoutSeconds)
    }

    public func connect(_ p: CBPeripheral, name: String? = nil, timeoutSeconds: Double = 15) async throws -> CBLens {
        try await connectPhased(p, name: name, required: Gatt.lensRequired, timeoutSeconds: timeoutSeconds)
    }

    /// Connect the R1 ring directly (for the R1Handoff fallback) and discover its GATT table; only
    /// BAE80012 is required. The ring is found by the identifier of an advert this process saw, or one
    /// iOS still knows (it holds the ring's pairing, or the Even app's link). Drop the link with
    /// `disconnect()` once the handoff is done: the glasses must own the ring.
    public func connectRing(id: UUID, name: String? = nil, timeoutSeconds: Double = 15) async throws -> CBLens {
        guard state == .poweredOn else { throw PhaseError("connect", BleError.unavailable(state.label)) }
        guard let p = known[id] ?? manager.retrievePeripherals(withIdentifiers: [id]).first else { throw PhaseError("connect", BleError.notFound) }
        return try await connectPhased(p, name: name ?? p.name ?? "R1 ring", required: Gatt.ringRequired, timeoutSeconds: timeoutSeconds)
    }

    /// Rings iOS holds (paired, or linked by the Even app). They do not advertise while held.
    public func connectedRings() -> [CBPeripheral] {
        guard state == .poweredOn else { return [] }
        return manager.retrieveConnectedPeripherals(withServices: [CBUUID(string: R1UUID.service)])
    }

    private func connectPhased(_ p: CBPeripheral, name: String?, required: [String], timeoutSeconds: Double) async throws -> CBLens {
        do {
            return try await attemptConnect(p, name: name, required: required, timeoutSeconds: timeoutSeconds)
        } catch let e as PhaseError {
            throw e
        } catch {
            throw PhaseError("connect", error)
        }
    }

    private func attemptConnect(_ p: CBPeripheral, name: String?, required: [String], timeoutSeconds: Double) async throws -> CBLens {
        guard state == .poweredOn else { throw BleError.unavailable(state.label) }
        let id = p.identifier
        if let pending = disconnecting[id] {
            // CoreBluetooth reuses CBPeripheral objects, so a timer must not expire this barrier:
            // its old disconnect callback could otherwise tear down the next wrapper for this UUID.
            if Date().timeIntervalSince(pending.started) >= 5 {
                let message = "Bluetooth did not acknowledge the previous disconnect. Close and reopen Jarvis before retrying."
                log("ble: \(tag(id, name)) \(message)")
                throw BleError.failed(message)
            }
            throw BleError.failed("The previous connection is still closing. Wait a moment and retry.")
        }
        guard p.state != .disconnecting else { throw BleError.failed("Bluetooth is still disconnecting this lens. Wait a moment and retry.") }
        if let lens = lenses[id], lens.isDiscovered, lens.peripheral.state == .connected { return lens }
        guard connectAttempts[id] == nil else { throw BleError.failed("Connection already in progress") }
        let attempt = UUID()
        connectAttempts[id] = attempt
        known[p.identifier] = p
        let lensName = name ?? adverts[id]?.name ?? p.name ?? p.identifier.uuidString
        let lens = CBLens(p, name: lensName, required: required)
        lens.central = self
        lenses[id] = lens
        let t = tag(id, lensName)
        do {
            do {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    connectConts[id] = c
                    let src = adverts[id].map { $0.source == .systemConnected ? "system" : "advert" } ?? (ringsSeen.contains(id) ? "advert" : "saved")
                    log("ble: \(t) connect issued (src=\(src), p.state=\(p.state.label))")
                    connectStarted[id] = Date()
                    // System-connected does not mean attached to this CBCentralManager.
                    manager.connect(p, options: nil)
                    connectTimeouts[id] = Task { [weak self] in
                        do { try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1e9)) } catch { return }
                        self?.log("ble: \(t) no didConnect in \(Int(timeoutSeconds)) s")
                        self?.release(id, attempt: attempt, error: BleError.timeout("no response from \(lensName) in \(Int(timeoutSeconds)) s"))
                    }
                }
            } catch {
                throw PhaseError("connect", error)
            }
            do {
                try await lens.discover()
            } catch {
                throw PhaseError("discovery", error)
            }
            guard connectAttempts[id] == attempt, lenses[id] === lens else { throw PhaseError("discovery", BleError.disconnected) }
            connectAttempts[id] = nil
            return lens
        } catch {
            release(id, attempt: attempt, error: error)
            throw error
        }
    }

    /// Release only connections this manager opened; this never forgets system pairing.
    /// Retry calls fail promptly until the cancellation is acknowledged. If no callback arrives
    /// within five seconds, they explain how to reset this app session instead of reusing the UUID.
    public func cancelConnections() {
        for id in Array(lenses.keys) { release(id, error: BleError.disconnected) }
    }

    func cancel(_ lens: CBLens) {
        guard lenses[lens.peripheral.identifier] === lens else { return }
        release(lens.peripheral.identifier, error: BleError.disconnected)
    }

    private func release(_ id: UUID, attempt: UUID? = nil, error: Error, cancelPeripheral: Bool = true) {
        if let attempt, connectAttempts[id] != attempt { return }
        connectAttempts[id] = nil
        connectTimeouts.removeValue(forKey: id)?.cancel()
        connectStarted[id] = nil
        let waiter = connectConts.removeValue(forKey: id)
        let lens = lenses.removeValue(forKey: id)
        lens?.central = nil
        // With the radio off iOS ignores the cancel and never reports a disconnect, so a barrier
        // set now would block this UUID forever.
        if cancelPeripheral, state == .poweredOn, let lens {
            disconnecting[id] = PendingDisconnection(peripheral: lens.peripheral, started: Date())
            manager.cancelPeripheralConnection(lens.peripheral)
        }
        waiter?.resume(throwing: error)
        lens?.didDisconnect()
    }

    /// Preserve real per-UUID metadata when a later advert or system retrieval omits it. A held arm
    /// gets back the serial and MAC persisted from an earlier advert (`G2IdentityStore`).
    private func cacheAdvert(_ p: CBPeripheral, name: String? = nil, rssi: Int? = nil, manufacturerData: [UInt8]? = nil,
                             source: AdvertSource) -> Advertisement? {
        let id = p.identifier
        let old = adverts[id]
        let names = [name, p.name, old?.name].compactMap { $0 }.filter { !$0.isEmpty }
        guard let name = names.first(where: { sideFromName($0) != nil }) ?? names.first(where: { $0.uppercased().hasPrefix("EVEN G2") }) else { return nil }
        var data = manufacturerData ?? old?.manufacturerData
        if let previous = old?.manufacturerData, let current = manufacturerData, previous.count > current.count {
            let oldSerial = parseG2Manufacturer(previous).serial, newSerial = parseG2Manufacturer(current).serial
            if newSerial == nil || newSerial == oldSerial { data = previous }
        }
        if parseG2Manufacturer(manufacturerData).serial != nil {
            identityOrigin[id] = "live"
            if G2IdentityStore.save(data, for: id.uuidString) {
                log("ble: \(lensTag(name, id.uuidString)) remembered serial \(parseG2Manufacturer(data).serial ?? "?") for id \(id.uuidString.prefix(8))")
            }
        } else if parseG2Manufacturer(data).serial == nil, let stored = G2IdentityStore.load(id.uuidString) {
            data = stored
            identityOrigin[id] = "persisted"
        }
        let advert = Advertisement(id: id.uuidString, name: name, rssi: rssi ?? old?.rssi, manufacturerData: data, source: source)
        adverts[id] = advert
        return advert
    }

    // MARK: CBCentralManagerDelegate

    public nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            state = central.state
            if state != .poweredOn {
                // The radio is off or reset: iOS ignores cancels now and never reports the disconnect,
                // and every CBPeripheral object it gave us is invalid. Drop the wrappers without a
                // cancel, clear the barriers, and forget the stale objects (`connect(id:)` prefers them).
                let dropped = lenses.count, barriers = disconnecting.count
                for id in Array(lenses.keys) { release(id, error: BleError.unavailable(state.label), cancelPeripheral: false) }
                disconnecting.removeAll()
                known.removeAll()
                scanActive = false
                recoveryPoll?.cancel(); recoveryPoll = nil
                log("ble: Bluetooth \(state.label): dropped \(dropped) lens wrappers, cleared \(barriers) disconnect barriers")
            }
            onState?(central.state)
        }
    }

    public nonisolated func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        MainActor.assumeIsolated {
            let ps = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
            for p in ps { known[p.identifier] = p; _ = cacheAdvert(p, source: .systemConnected) }
            onRestore?(ps)
        }
    }

    public nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                           advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
            let fullMfr = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data).map { [UInt8]($0) }
            // R1 ring: its MAC is the last 6 bytes of the FULL manufacturer data, raw order (RingAdvert).
            if let ringName = [localName, peripheral.name].compactMap({ $0 }).first(where: { RingAdvert.isRingName($0) }) {
                let ring = RingAdvert(id: peripheral.identifier.uuidString, name: ringName, rssi: RSSI.intValue, manufacturerData: fullMfr ?? [])
                known[peripheral.identifier] = peripheral
                ringsSeen.insert(peripheral.identifier)
                if ringsLogged.insert(peripheral.identifier).inserted { log(ring.logLine) }
                onRing?(ring)
                return
            }
            // CoreBluetooth keeps the 2-byte company id in front of the manufacturer data; strip it.
            let md = fullMfr.map { Array($0.dropFirst(2)) }
            guard let advert = cacheAdvert(peripheral, name: localName, rssi: RSSI.intValue, manufacturerData: md, source: .advert) else {
                // Diagnostics: other Even devices (other glasses, unknown models) once per identifier.
                let other = localName ?? peripheral.name ?? ""
                if other.uppercased().contains("EVEN") || other.uppercased().hasPrefix("R1"), !reportedOthers.contains(peripheral.identifier) {
                    reportedOthers.insert(peripheral.identifier)
                    let mdHex = md.map { hex($0) } ?? "-"
                    let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map(\.uuidString).joined(separator: ",") ?? "-"
                    log("ble: saw non-G2 Even device \(other) id \(peripheral.identifier.uuidString.prefix(8)) rssi \(RSSI.intValue) services \(services) mfr \(mdHex)")
                }
                return
            }
            known[peripheral.identifier] = peripheral
            onAdvert?(advert)
        }
    }

    public nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            let id = peripheral.identifier
            guard lenses[id]?.peripheral === peripheral else { return }
            if let started = connectStarted.removeValue(forKey: id) {
                let ms = Int(Date().timeIntervalSince(started) * 1000)
                // Near-instant means the link already existed: iOS or another app holds it.
                log("ble: \(tag(id)) didConnect +\(ms) ms\(ms < 60 ? " (link was already up: held by iOS or another app?)" : "")")
            }
            connectTimeouts.removeValue(forKey: id)?.cancel()
            connectConts.removeValue(forKey: id)?.resume()
        }
    }

    public nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            let id = peripheral.identifier
            if disconnecting[id]?.peripheral === peripheral {
                disconnecting[id] = nil
                return
            }
            guard lenses[id]?.peripheral === peripheral else { return }
            log("ble: \(tag(id)) connect failed \(disconnectErrorText(error))")
            release(id, error: error ?? BleError.failed("connect failed"), cancelPeripheral: false)
        }
    }

    public nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            let id = peripheral.identifier
            if disconnecting[id]?.peripheral === peripheral {
                disconnecting[id] = nil
                log("ble: \(tag(id)) disconnected (requested by Jarvis)")
                return
            }
            guard let lens = lenses[id], lens.peripheral === peripheral else { return }
            let idle = lens.lastWrite.map { String(format: "%.1fs", Date().timeIntervalSince($0)) } ?? "never-written"
            log("ble: \(tag(id)) disconnected \(disconnectErrorText(error)) idle=\(idle)")
            release(id, error: error ?? BleError.disconnected, cancelPeripheral: false)
        }
    }
}
#endif
