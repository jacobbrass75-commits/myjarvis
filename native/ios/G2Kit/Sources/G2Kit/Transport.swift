// Transport abstraction. The protocol code only needs "write bytes to characteristic X" and "give me
// notifications from characteristic Y" on two peripherals (left and right lens), so it runs over
// CoreBluetooth (CoreBluetoothTransport.swift) or an in-memory mock in tests.
// Port of native/driver/src/transport.ts.

import Foundation

public enum Side: String, Codable, Equatable, CaseIterable {
    case left, right
}

@MainActor
public protocol BlePeripheral: AnyObject {
    var id: String { get }
    var name: String { get }
    func write(_ characteristic: String, _ data: [UInt8], withoutResponse: Bool) async throws
    /// Enable notifications; returns an unsubscribe function.
    func subscribe(_ characteristic: String, _ onData: @escaping @MainActor ([UInt8]) -> Void) async throws -> @MainActor () -> Void
    func onDisconnect(_ cb: @escaping @MainActor () -> Void)
    func disconnect()
    /// Whether the peripheral exposes this characteristic (UUID compared case-insensitively).
    func has(_ characteristic: String) -> Bool
    /// Wait until the link can take another write-without-response (CoreBluetooth's
    /// `canSendWriteWithoutResponse`), at most `timeoutMs`. False on timeout: the caller writes anyway,
    /// as it did before flow control (a backgrounded central may never be told it is ready).
    func waitWritable(timeoutMs: Int) async -> Bool
}

public extension BlePeripheral {
    /// Transports without a write buffer to watch (mocks, other stacks) are always writable.
    func waitWritable(timeoutMs: Int) async -> Bool { true }
}

/// How an arm reached us: its own advertisement, or `retrieveConnectedPeripherals` because iOS or
/// another app (usually the Even app) already holds its link. A held arm does not advertise.
public enum AdvertSource: String {
    case advert, systemConnected
}

public struct Advertisement: Equatable {
    /// Platform id (CoreBluetooth UUID on iOS/macOS).
    public var id: String
    public var name: String
    public var rssi: Int?
    /// Manufacturer-specific data WITHOUT the 2-byte company id.
    public var manufacturerData: [UInt8]?
    public var source: AdvertSource = .advert

    public init(id: String, name: String, rssi: Int? = nil, manufacturerData: [UInt8]? = nil, source: AdvertSource = .advert) {
        self.id = id; self.name = name; self.rssi = rssi; self.manufacturerData = manufacturerData; self.source = source
    }
}

/// Discovery bookkeeping for one lens, kept free of CoreBluetooth so it can be unit tested.
///
/// On current firmware the characteristics sit under several services (5401/5402 under 5450, 6402
/// under 6450), so every service is walked and the characteristics are merged by uppercased UUID. A
/// characteristic found under its expected service wins over a copy elsewhere. Only 5401 and 5402
/// are required; one service failing to list its characteristics is logged, not fatal.
struct GattCatalog<Characteristic> {
    struct Found {
        var uuid: String
        var properties: String
        var value: Characteristic
    }
    struct Entry {
        var service: String
        var value: Characteristic
    }

    /// What a G2 lens must expose; the rest (6402, 7401/7402) is optional.
    static var lensRequired: [String] { [G2UUID.write, G2UUID.notify] }
    /// What the R1 ring must expose for the direct handoff (R1Handoff writes BAE80012).
    static var ringRequired: [String] { [R1UUID.write2] }
    /// Where each characteristic is expected to live.
    static var expectedService: [String: String] {
        [G2UUID.write: G2UUID.controlService, G2UUID.notify: G2UUID.controlService,
         base("6401"): G2UUID.audioService, G2UUID.audioNotify: G2UUID.audioService,
         G2UUID.fileWrite: G2UUID.fileService, G2UUID.fileNotify: G2UUID.fileService]
    }
    private static func base(_ suffix: String) -> String { G2UUID.base(suffix) }

    /// Characteristics discovery must find (5401/5402 for a lens).
    let required: [String]
    private(set) var entries: [String: Entry] = [:]
    private var pending: [String: Int] = [:]
    /// One `…5450[5401 wnr,5402 ntf]` fragment per reported service, in report order.
    private(set) var summary: [String] = []

    init(required: [String] = GattCatalog.lensRequired) { self.required = required }

    var isComplete: Bool { pending.isEmpty }
    var missing: [String] { required.filter { entries[$0.uppercased()] == nil } }

    func has(_ uuid: String) -> Bool { entries[uuid.uppercased()] != nil }
    func value(_ uuid: String) -> Characteristic? { entries[uuid.uppercased()]?.value }

    /// Starts a round with the services iOS reported (clearing any earlier round).
    mutating func begin(services: [String]) {
        entries.removeAll(); summary.removeAll(); pending.removeAll()
        for s in services { pending[s.uppercased(), default: 0] += 1 }
    }

    /// Records one service's characteristics, or its error. Returns true once every service reported.
    @discardableResult
    mutating func add(service: String, found: [Found], error: String? = nil) -> Bool {
        let svc = service.uppercased()
        if let n = pending[svc] { pending[svc] = n > 1 ? n - 1 : nil }
        if let error {
            summary.append("\(Self.short(svc, service: true))[error: \(error)]")
            return isComplete
        }
        for ch in found {
            let key = ch.uuid.uppercased()
            if let existing = entries[key], Self.expectedService[key] == existing.service { continue }
            if entries[key] == nil || Self.expectedService[key] == svc { entries[key] = Entry(service: svc, value: ch.value) }
        }
        let chars = found.map { "\(Self.short($0.uuid)) \($0.properties)" }.joined(separator: ",")
        summary.append("\(Self.short(svc, service: true))[\(chars)]")
        return isComplete
    }

    /// Drops the characteristics of services iOS invalidated; returns the dropped UUIDs.
    mutating func invalidate(services: [String]) -> [String] {
        let gone = Set(services.map { $0.uppercased() })
        let dropped = entries.filter { gone.contains($0.value.service) }.map(\.key).sorted()
        for key in dropped { entries[key] = nil }
        return dropped
    }

    /// "…5450" for an Even service, "5401" for an Even characteristic, the first 8 hex digits for
    /// other 128-bit UUIDs, 16-bit UUIDs as they are.
    static func short(_ uuid: String, service: Bool = false) -> String {
        let u = uuid.uppercased(), prefix = G2UUID.base("")
        if u.hasPrefix(prefix), u.count == prefix.count + 4 { return (service ? "…" : "") + u.dropFirst(prefix.count) }
        if u.count == 36 { return String(u.prefix(8)) }
        return u
    }

    static func propertyLabel(read: Bool, write: Bool, writeWithoutResponse: Bool, notify: Bool, indicate: Bool) -> String {
        let parts = [(read, "r"), (write, "w"), (writeWithoutResponse, "wnr"), (notify, "ntf"), (indicate, "ind")]
            .filter(\.0).map(\.1)
        return parts.isEmpty ? "-" : parts.joined(separator: "+")
    }
}

/// Remembers each lens's manufacturer data (serial + MAC, company id stripped) by CoreBluetooth UUID
/// under `g2.mfr.<uuid>`, so an arm that iOS or another app holds (it stops advertising, and
/// retrieval carries no manufacturer data) keeps its serial and MAC.
public enum G2IdentityStore {
    public static func key(_ id: String) -> String { "g2.mfr.\(id.uppercased())" }

    public static func load(_ id: String, defaults: UserDefaults = .standard) -> [UInt8]? {
        guard let s = defaults.string(forKey: key(id)), !s.isEmpty, s.count % 2 == 0, s.allSatisfy(\.isHexDigit) else { return nil }
        let data = fromHex(s)
        return parseG2Manufacturer(data).serial == nil ? nil : data
    }

    /// Stores data that carries a serial. Returns true when the stored value changed.
    @discardableResult
    public static func save(_ data: [UInt8]?, for id: String, defaults: UserDefaults = .standard) -> Bool {
        guard let data, parseG2Manufacturer(data).serial != nil else { return false }
        let value = hex(data)
        guard defaults.string(forKey: key(id)) != value else { return false }
        defaults.set(value, forKey: key(id))
        return true
    }
}

/// "Even G2_32_L_1A2B3C" -> .left.
public func sideFromName(_ name: String) -> Side? {
    let n = name.uppercased()
    guard n.contains("G2") else { return nil }
    if n.contains("_L_") { return .left }
    if n.contains("_R_") { return .right }
    return nil
}

/// G2 manufacturer data (company id stripped): bytes 0..13 ASCII serial (shared by both lenses,
/// used to pair L with R), bytes 14..19 the lens BLE MAC in little-endian order.
public func parseG2Manufacturer(_ data: [UInt8]?) -> (serial: String?, mac: String?) {
    guard let data, data.count >= 14 else { return (nil, nil) }
    let s = String(decoding: data[0..<14], as: UTF8.self).filter { c in
        c.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F }
    }
    let serial = s.isEmpty ? nil : s
    guard data.count >= 20 else { return (serial, nil) }
    return (serial, formatMac(Array(data[14..<20].reversed())))
}

public struct G2Lens: Equatable {
    public var advert: Advertisement
    public var side: Side
    public var mac: String?
}

public struct G2Pair: Equatable {
    public var serial: String
    public var left: G2Lens
    public var right: G2Lens
}

/// Collects adverts until both lenses of one pair are seen (optionally matching a serial substring).
public struct PairFinder {
    /// Receives one `pair: L=… src=… serial=… · R=… → decision` line whenever the decision changes.
    /// Static so it survives the `PairFinder()` resets of each scan; set it once at startup.
    nonisolated(unsafe) public static var log: ((String) -> Void)?

    public var serialFilter: String?
    public private(set) var seen: [String: [Side: G2Lens]] = [:]
    /// The last decision line `add` produced (also sent to `PairFinder.log` when it changes).
    public private(set) var lastDecision: String?
    private var observations: [String: G2Lens] = [:]

    public init(serialFilter: String? = nil) { self.serialFilter = serialFilter }

    /// Offers the only observed arms for explicit user confirmation, without inferring identity.
    /// This candidate is never used by `add` to pair automatically.
    public var pairRequiringConfirmation: G2Pair? {
        let left = observations.values.filter { $0.side == .left }
        let right = observations.values.filter { $0.side == .right }
        guard left.count == 1, right.count == 1,
              let l = left.first, let r = right.first, l.advert.id != r.advert.id else { return nil }
        let leftSerial = serial(l), rightSerial = serial(r)
        if let leftSerial, let rightSerial, leftSerial != rightSerial { return nil }
        let knownSerial = leftSerial ?? rightSerial
        if let knownSerial, !matchesFilter(knownSerial) { return nil }
        return G2Pair(serial: knownSerial ?? "", left: l, right: r)
    }

    private enum MatchReason: String {
        case serial, suffix = "name suffix", bothSystemHeld = "both system-held"
    }

    /// Returns the pair once both lenses of it have been seen.
    public mutating func add(_ a: Advertisement) -> G2Pair? {
        let previous = observations[a.id]
        let name = sideFromName(a.name) == nil ? previous?.advert.name ?? a.name : a.name
        guard let side = sideFromName(name) else { return nil }
        let oldData = previous?.advert.manufacturerData
        let oldSerial = identity(parseG2Manufacturer(oldData).serial)
        let newSerial = identity(parseG2Manufacturer(a.manufacturerData).serial)
        // Retrieved peripherals and sparse advertisements may omit earlier metadata. A new,
        // conflicting serial replaces the old identity rather than mixing their MAC/serial data.
        let keepOldData = oldData != nil && (a.manufacturerData == nil ||
            (oldSerial != nil && newSerial == nil) ||
            (oldSerial == newSerial && oldData!.count > (a.manufacturerData?.count ?? 0)))
        let data = keepOldData ? oldData : a.manufacturerData
        // The latest sighting says how the arm is reachable now (an arm that advertises is not held).
        let merged = Advertisement(id: a.id, name: name, rssi: a.rssi ?? previous?.advert.rssi, manufacturerData: data, source: a.source)
        observations[a.id] = G2Lens(advert: merged, side: side, mac: parseG2Manufacturer(data).mac)

        // Rebuild the public index so an enriched UUID cannot remain in a stale name bucket.
        seen.removeAll(keepingCapacity: true)
        for lens in observations.values.sorted(by: { $0.advert.id < $1.advert.id }) {
            guard let key = serial(lens) ?? suffix(lens), matchesFilter(key) else { continue }
            seen[key, default: [:]][lens.side] = lens
        }

        let left = observations.values.filter { $0.side == .left }
        let right = observations.values.filter { $0.side == .right }
        var matches: [(left: G2Lens, right: G2Lens, strength: Int, reason: MatchReason)] = []
        for l in left {
            for r in right {
                let strength = matchStrength(l, r)
                if strength > 0 { matches.append((l, r, strength, strength == 2 ? .serial : .suffix)) }
            }
        }
        // Held arms do not advertise, so they often have no serial (unless one was persisted) and
        // their per-arm name suffixes rarely agree. When the only two arms in sight are both held by
        // iOS or another app and their serials do not conflict, they are this phone's pair. One held
        // arm plus one advertising arm ("mixed") stays on explicit confirmation.
        if left.count == 1, right.count == 1, let l = left.first, let r = right.first,
           l.advert.id != r.advert.id, l.advert.source == .systemConnected, r.advert.source == .systemConnected,
           !serialsConflict(l, r), !matches.contains(where: { $0.strength >= 2 }) {
            matches.removeAll()
            matches.append((l, r, 2, .bothSystemHeld))
        }
        // Exact serial matches outrank the legacy name-suffix fallback. Each chosen arm must
        // have exactly one compatible peer at that strength or better; proximity is not identity.
        for match in matches.sorted(by: { $0.strength > $1.strength }) where match.left.advert.id == a.id || match.right.advert.id == a.id {
            let leftChoices = matches.filter { $0.left.advert.id == match.left.advert.id && $0.strength >= match.strength }.count
            let rightChoices = matches.filter { $0.right.advert.id == match.right.advert.id && $0.strength >= match.strength }.count
            let key = serial(match.left) ?? serial(match.right) ?? suffix(match.left) ?? ""
            guard leftChoices == 1, rightChoices == 1, matchesFilter(key) else { continue }
            decide("auto(\(match.reason.rawValue))")
            return G2Pair(serial: key, left: match.left, right: match.right)
        }
        decide(unpairedReason(left: left, right: right))
        return nil
    }

    private func unpairedReason(left: [G2Lens], right: [G2Lens]) -> String {
        if left.isEmpty { return "none(no left arm yet)" }
        if right.isEmpty { return "none(no right arm yet)" }
        if left.count > 1 || right.count > 1 { return "none(ambiguous: \(left.count) left, \(right.count) right)" }
        if let candidate = pairRequiringConfirmation {
            return candidate.left.advert.source != candidate.right.advert.source ? "confirm(mixed)" : "confirm(no shared serial)"
        }
        if let l = left.first, let r = right.first {
            if l.advert.id == r.advert.id { return "none(same UUID on both sides)" }
            if serialsConflict(l, r) { return "none(serials differ)" }
        }
        return "none(serial filter)"
    }

    private mutating func decide(_ outcome: String) {
        let arms = observations.values
            .sorted { ($0.side == .left ? 0 : 1, $0.advert.id) < ($1.side == .left ? 0 : 1, $1.advert.id) }
            .map { l in
                let src = l.advert.source == .systemConnected ? "system" : "advert"
                return "\(l.side == .left ? "L" : "R")=\(l.advert.id.prefix(8)) src=\(src) serial=\(serial(l) ?? "none")"
            }
            .joined(separator: " · ")
        let line = "pair: \(arms) → \(outcome)"
        guard line != lastDecision else { return }
        lastDecision = line
        PairFinder.log?(line)
    }

    private func serialsConflict(_ l: G2Lens, _ r: G2Lens) -> Bool {
        guard let a = serial(l), let b = serial(r) else { return false }
        return a != b
    }

    private func identity(_ value: String?) -> String? {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), !normalized.isEmpty else { return nil }
        return normalized
    }

    private func serial(_ lens: G2Lens) -> String? { identity(parseG2Manufacturer(lens.advert.manufacturerData).serial) }

    private func suffix(_ lens: G2Lens) -> String? {
        let marker = lens.side == .left ? "_L_" : "_R_"
        return identity(lens.advert.name.uppercased().components(separatedBy: marker).dropFirst().first)
    }

    private func matchesFilter(_ key: String) -> Bool {
        guard let filter = identity(serialFilter) else { return true }
        return key.contains(filter)
    }

    private func matchStrength(_ left: G2Lens, _ right: G2Lens) -> Int {
        guard left.advert.id != right.advert.id else { return 0 }
        if let l = serial(left), let r = serial(right) { return l == r ? 2 : 0 }
        guard let l = suffix(left), let r = suffix(right), l == r else { return 0 }
        return 1
    }
}
