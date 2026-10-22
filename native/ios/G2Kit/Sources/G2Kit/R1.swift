// Even R1 ring helpers. Port of native/driver/src/r1.ts, plus the official command framing
// (workbench r1_protocol.dart, checked against two com.even.sg captures).
//
// Normal operation: the ring is bound to the glasses and relays gestures to them; the glasses report
// them on EvenHub as Sys_ItemEvent with EventSource = RING (2). So for UI input you do NOT need to
// connect to the ring at all: capture its MAC from its advertisement (RingAdvert) and ask the right
// lens to link it (G2Driver.bindRing). The frame builders below are for the optional direct
// phone-to-ring handoff (pair_auth, system_time, adv_start); see PROTOCOL.md §12.

import Foundation

public enum RingGesture: String, Equatable { case hold, tap, doubleTap = "double_tap", swipeUp = "swipe_up", swipeDown = "swipe_down" }

public enum RingNotification: Equatable {
    case gesture(RingGesture)
    case battery(Int)
    case state(ready: Bool?, raw: UInt8)
    case unknown
}

/// Parse a ring notification. Recognises [0xFF, type, param] anywhere in the packet (MentraOS).
public func parseRingNotification(_ data: [UInt8]) -> RingNotification {
    if let ff = data.firstIndex(of: 0xFF), ff + 2 < data.count {
        let type = data[ff + 1], param = data[ff + 2]
        switch type {
        case 0x03: return .gesture(.hold)
        case 0x04 where param == 0x01: return .gesture(.tap)
        case 0x04 where param == 0x02: return .gesture(.doubleTap)
        case 0x05: return .gesture(param < 0x80 ? .swipeUp : .swipeDown)
        default: break
        }
    }
    if data.count == 2 && data[0] <= 100 { return .battery(Int(data[0])) }
    if data.count == 1 { return .state(ready: data[0] == 1 ? true : data[0] == 0 ? false : nil, raw: data[0]) }
    return .unknown
}

public enum RingError: Error, Equatable, CustomStringConvertible {
    case badMac(count: Int)
    /// The ring exposes neither BAE80011 nor BAE80013, so its acks cannot be read.
    case noNotifyCharacteristic(String)
    public var description: String {
        switch self {
        case let .badMac(n): return "ring MAC must be 6 bytes (got \(n))"
        case let .noNotifyCharacteristic(name): return "\(name) has neither BAE80011 nor BAE80013"
        }
    }
}

// MARK: - advertisement

/// How the advertised name relates to the MAC bytes (g2-kit ring.ts: the name ends in the last 3
/// MAC bytes, and the manufacturer blob carries the MAC reversed).
public enum RingNameCheck: String, Equatable {
    /// name suffix == hex(raw[2], raw[1], raw[0]): raw bytes are the MAC reversed (expected).
    case littleEndian = "LE"
    /// name suffix == hex(raw[3], raw[4], raw[5]): raw bytes are already in printed order.
    case bigEndian = "BE"
    case mismatch
    /// No "R1_XXXXXX" suffix or no MAC.
    case unknown

    /// The name confirms the bytes (either order). Only a confirmed MAC may come from an advert:
    /// a "BCL60…" name has no suffix, so its bytes could be any nearby device's.
    public var verified: Bool { self == .littleEndian || self == .bigEndian }
}

/// One sighting of an R1 ring advertisement.
public struct RingAdvert: Equatable {
    public let id: String
    public let name: String
    public let rssi: Int?
    /// FULL manufacturer data, including the 2-byte company id ("ER" = 45 52).
    public let manufacturerData: [UInt8]
    /// Ring BLE MAC in RAW order: the 6 bytes that the name confirms (see `macRaw(fromManufacturer:name:)`).
    /// Send exactly these bytes in RING_CONNECT_INFO.
    public var macRaw: [UInt8]?

    public init(id: String, name: String, rssi: Int? = nil, manufacturerData: [UInt8], macRaw: [UInt8]? = nil) {
        self.id = id; self.name = name; self.rssi = rssi; self.manufacturerData = manufacturerData
        self.macRaw = macRaw ?? RingAdvert.macRaw(fromManufacturer: manufacturerData, name: name)
    }

    /// "EVEN R1_CEC5BA" (any case), or the BCL60x module name some rings use.
    public static func isRingName(_ name: String?) -> Bool {
        guard let name else { return false }
        let n = name.uppercased()
        return n.hasPrefix("EVEN R1_") || n.contains("BCL60")
    }

    /// Last 6 bytes of the FULL manufacturer data, raw order; nil if shorter than 6.
    public static func macRaw(fromManufacturer data: [UInt8]?) -> [UInt8]? {
        guard let data, data.count >= 6 else { return nil }
        return Array(data.suffix(6))
    }

    /// The MAC inside the FULL manufacturer data, raw order. Older rings end the blob with it (MentraOS
    /// `mfgData.suffix(6)`); current firmware puts it right after the company id and appends an ASCII
    /// serial (hardware, EVEN R1_C7D8E9: 45 52 | E9 D8 C7 01 00 02 | "B000TEST0080032"). Takes the first
    /// candidate the name confirms, else the suffix (unverified, so callers never store or send it).
    public static func macRaw(fromManufacturer data: [UInt8]?, name: String) -> [UInt8]? {
        guard let data, data.count >= 6 else { return nil }
        var candidates = [Array(data.suffix(6))]
        if data.count >= 8 { candidates.append(Array(data[2..<8])) }
        return candidates.first { check(raw: $0, name: name).verified } ?? candidates[0]
    }

    static func check(raw: [UInt8]?, name: String) -> RingNameCheck {
        guard let raw, raw.count == 6, let suffix = R1.ringId(fromName: name)?.uppercased(), suffix.count == 6 else {
            return .unknown
        }
        if suffix == hex([raw[2], raw[1], raw[0]]).uppercased() { return .littleEndian }
        if suffix == hex([raw[3], raw[4], raw[5]]).uppercased() { return .bigEndian }
        return .mismatch
    }

    public var nameCheck: RingNameCheck { RingAdvert.check(raw: macRaw, name: name) }

    /// MAC as normally printed (most significant byte first), using the name check to pick the order.
    public var mac: String? {
        guard let raw = macRaw, raw.count == 6 else { return nil }
        return formatMac(nameCheck == .bigEndian ? raw : Array(raw.reversed()))
    }

    /// `ring: seen EVEN R1_CEC5BA id 9F3E… rssi -61 mfr 4552…; mac raw BA C5 CE 33 22 11 → 11:22:33:CE:C5:BA name-check ok (LE)`
    public var logLine: String {
        let shortId = id.count > 8 ? String(id.prefix(8)) + "…" : id
        var s = "ring: seen \(name) id \(shortId) rssi \(rssi.map(String.init) ?? "?") mfr \(manufacturerData.isEmpty ? "none" : hex(manufacturerData))"
        guard let raw = macRaw else { return s + "; no MAC (manufacturer data too short)" }
        s += "; mac raw \(raw.map { String(format: "%02X", $0) }.joined(separator: " ")) → \(mac ?? "?")"
        switch nameCheck {
        case .littleEndian: s += " name-check ok (LE)"
        case .bigEndian: s += " name-check ok (BE, raw is printed order)"
        case .mismatch: s += " name-check MISMATCH (name \(R1.ringId(fromName: name) ?? "?"))"
        case .unknown: s += " name-check n/a"
        }
        return s
    }
}

// MARK: - R1 command frames

/// CRC-32C as the R1 transfer wrapper uses it: poly 0x1EDC6F41, NOT reflected, init 0, no final XOR.
/// Verified on two official captures (pair_auth -> 0xF9531997, adv_start -> 0x48120CC5).
private let r1Crc32Table: [UInt32] = (0..<256).map { i -> UInt32 in
    var c = UInt32(i) << 24
    for _ in 0..<8 { c = (c & 0x8000_0000) != 0 ? (c << 1) ^ 0x1EDC_6F41 : c << 1 }
    return c
}

public func r1Crc32c<C: Collection>(_ data: C) -> UInt32 where C.Element == UInt8 {
    var crc: UInt32 = 0
    for b in data { crc = (crc << 8) ^ r1Crc32Table[Int(UInt8(truncatingIfNeeded: crc >> 24) ^ b)] }
    return crc
}

/// Ack result in status bits 2..3.
public enum R1AckStatus: String, Equatable {
    case ok, error, refuse, unsupported
}

/// A decoded single-packet R1 transfer.
public struct R1Frame: Equatable {
    public let transferIndex: UInt8
    /// Outer CRC-32C over the model matches.
    public let transferCrcOk: Bool
    /// Inner CRC-16 (field zeroed) matches. The official app's values do not, so do not gate on it.
    public let modelCrcOk: Bool
    public let version: UInt8
    public let command: UInt8
    public let moduleVersion: UInt8
    public let serial: UInt16
    public let status: UInt8
    public let module: UInt8
    public let sub: UInt8
    public let data: [UInt8]

    /// Status bit 0 is set on acks (clear on notifications / requests).
    public var isAck: Bool { status & 0x01 != 0 }
    public var isSet: Bool { status & 0x02 != 0 }
    public var ackStatus: R1AckStatus {
        switch (status >> 2) & 0x03 {
        case 0: return .ok
        case 1: return .error
        case 2: return .refuse
        default: return .unsupported
        }
    }
}

public enum R1 {
    /// MentraOS init: 0xFC then (200 ms later) 0x11, written without response to both write chars.
    public static let initSequence: [[UInt8]] = [[0xFC], [0x11]]

    /// Superseded: MentraOS's raw 9-byte write with the LEFT lens MAC, which is not what the
    /// official app sends. Use `advStart(glassesMacRaw:serial:)`.
    @available(*, deprecated, message: "not the official framing; use advStart(glassesMacRaw:serial:)")
    public static func advStart(glassesLeftMac: [UInt8]) -> [UInt8] {
        precondition(glassesLeftMac.count == 6, "MAC must be 6 bytes")
        return [0x00, 0x00, 0x09] + glassesLeftMac
    }

    /// Ring id from the advertised name, e.g. "EVEN R1_CEC5BA" -> "CEC5BA".
    public static func ringId(fromName name: String) -> String? {
        guard let r = name.range(of: "R1_"), r.upperBound < name.endIndex else { return nil }
        return String(name[r.upperBound...])
    }

    // Official framing (workbench r1_protocol.dart):
    //   frame = 00 | crc32c(model) u32 LE | model
    //   model = 64 01 64 | serial u16 LE | status | 00 (system module) | sub | len u16 LE (12 + data) | crc16 u16 LE | data
    // crc16 is CRC-16/CCITT-FALSE over the model with its own field zeroed.
    static let version: UInt8 = 100
    static let systemCommand: UInt8 = 1
    static let moduleVersion: UInt8 = 100
    static let systemModule: UInt8 = 0
    static let modelHeaderLength = 12

    public enum Sub {
        public static let deviceStatus: UInt8 = 1
        public static let systemTime: UInt8 = 5
        public static let touchStatus: UInt8 = 6
        public static let touchSwitch: UInt8 = 7
        public static let pairAuth: UInt8 = 8
        public static let advStart: UInt8 = 10
    }

    /// Write these to BAE80012 (write2) after subscribing BAE80011 + BAE80013 and waiting ~1.1 s.
    public static func command(sub: UInt8, serial: UInt16, status: UInt8 = 0, data: [UInt8] = []) -> [UInt8] {
        var model: [UInt8] = [version, systemCommand, moduleVersion, UInt8(serial & 0xFF), UInt8(serial >> 8), status, systemModule, sub]
        let len = UInt16(modelHeaderLength + data.count)
        model += [UInt8(len & 0xFF), UInt8(len >> 8), 0, 0]
        model += data
        let c16 = crc16(model)
        model[10] = UInt8(c16 & 0xFF)
        model[11] = UInt8(c16 >> 8)
        let c32 = r1Crc32c(model)
        return [0x00, UInt8(c32 & 0xFF), UInt8((c32 >> 8) & 0xFF), UInt8((c32 >> 16) & 0xFF), UInt8(c32 >> 24)] + model
    }

    /// pair_auth (sub 8, data 01). Without it GATT writes succeed but the ring stays silent.
    public static func pairAuth(serial: UInt16) -> [UInt8] {
        command(sub: Sub.pairAuth, serial: serial, data: [0x01])
    }

    /// system_time (sub 5, status 02 = set): i16 timezone minutes LE + u32 unix seconds LE, padded to 12 bytes.
    public static func systemTime(serial: UInt16, now: Date = Date(), timeZone: TimeZone = .current) -> [UInt8] {
        let tz = Int16(clamping: timeZone.secondsFromGMT(for: now) / 60)
        let t = UInt32(clamping: Int64(now.timeIntervalSince1970.rounded(.down)))
        var data = [UInt8](repeating: 0, count: 12)
        data[0] = UInt8(UInt16(bitPattern: tz) & 0xFF)
        data[1] = UInt8(UInt16(bitPattern: tz) >> 8)
        for i in 0..<4 { data[2 + i] = UInt8((t >> (8 * UInt32(i))) & 0xFF) }
        return command(sub: Sub.systemTime, serial: serial, status: 0x02, data: data)
    }

    /// adv_start (sub 10): tell the ring which glasses to link to. `glassesMacRaw` is the RIGHT
    /// lens MAC in raw advert order (stripped manufacturer bytes 14..19, NOT reversed).
    public static func advStart(glassesMacRaw: [UInt8], serial: UInt16) throws -> [UInt8] {
        guard glassesMacRaw.count == 6 else { throw RingError.badMac(count: glassesMacRaw.count) }
        return command(sub: Sub.advStart, serial: serial, data: glassesMacRaw)
    }

    /// device_status query (sub 1); the ack's first data byte is the battery level.
    public static func deviceStatus(serial: UInt16) -> [UInt8] {
        command(sub: Sub.deviceStatus, serial: serial)
    }

    /// Decode a complete single-packet transfer; nil for legacy bytes or incomplete data.
    public static func parse(_ frame: [UInt8]) -> R1Frame? {
        guard frame.count >= 5 + modelHeaderLength else { return nil }
        let declared = Int(frame[13]) | Int(frame[14]) << 8
        guard declared >= modelHeaderLength, frame.count >= 5 + declared else { return nil }
        let model = Array(frame[5..<(5 + declared)])
        let outer = UInt32(frame[1]) | UInt32(frame[2]) << 8 | UInt32(frame[3]) << 16 | UInt32(frame[4]) << 24
        var zeroed = model
        zeroed[10] = 0
        zeroed[11] = 0
        let inner = UInt16(model[10]) | UInt16(model[11]) << 8
        return R1Frame(
            transferIndex: frame[0], transferCrcOk: r1Crc32c(model) == outer, modelCrcOk: crc16(zeroed) == inner,
            version: model[0], command: model[1], moduleVersion: model[2], serial: UInt16(model[3]) | UInt16(model[4]) << 8,
            status: model[5], module: model[6], sub: model[7], data: Array(model[modelHeaderLength...])
        )
    }

    /// Battery level from a device_status ack, if this is one.
    public static func battery(from f: R1Frame) -> Int? {
        guard f.command == systemCommand, f.module == systemModule, f.sub == Sub.deviceStatus, f.isAck, f.ackStatus == .ok,
              let b = f.data.first, b <= 100 else { return nil }
        return Int(b)
    }
}

// MARK: - direct phone -> ring handoff (fallback)

/// What the ring answered to one command of the handoff.
public enum R1AckOutcome: Equatable, CustomStringConvertible {
    case ack(R1AckStatus)
    case timeout

    public var description: String {
        switch self {
        case .ack(let s): return s.rawValue
        case .timeout: return "timeout"
        }
    }
}

public struct R1HandoffResult: Equatable {
    public var pairAuth: R1AckOutcome
    public var advStart: R1AckOutcome
    /// The ring accepted adv_start. A refusal can still leave an earlier link working (workbench).
    public var accepted: Bool { advStart == .ack(.ok) }
}

/// The right lens MAC in RAW advert order: stripped manufacturer bytes 14..19, NOT reversed (what
/// adv_start carries). nil when the data carries no MAC.
public func g2MacRaw(fromManufacturer data: [UInt8]?) -> [UInt8]? {
    guard let data, data.count >= 20 else { return nil }
    return Array(data[14..<20])
}

/// Whether a lens MAC in raw advert order (`g2MacRaw`) belongs to the lens with this name: the name
/// ends in the last 3 MAC bytes as printed ("Even G2_32_L_A1B2C3" advertises 02:00:00:A1:B2:C3, raw
/// 42 06 63 62 AB CC). nil when the name has no 6-hex-digit L/R suffix to check against.
/// adv_start with the wrong MAC points the ring at glasses that do not exist, so check before sending.
public func g2MacMatchesName(_ macRaw: [UInt8], name: String?) -> Bool? {
    guard macRaw.count == 6, let name, let side = sideFromName(name) else { return nil }
    let marker = side == .left ? "_L_" : "_R_"
    guard let suffix = name.uppercased().components(separatedBy: marker).last?.trimmingCharacters(in: .whitespaces),
          suffix.count == 6, suffix.allSatisfy(\.isHexDigit) else { return nil }
    return suffix == hex([macRaw[2], macRaw[1], macRaw[0]]).uppercased()
}

/// Matches R1 acks to the request serial they answer. An ack that lands before its wait starts
/// (a fast or mocked ring) is kept for it.
@MainActor
private final class R1AckWaiter {
    private var waiting: [UInt16: CheckedContinuation<R1AckStatus?, Never>] = [:]
    private var early: [UInt16: R1AckStatus] = [:]

    func resolve(_ serial: UInt16, _ status: R1AckStatus?) {
        if let c = waiting.removeValue(forKey: serial) { c.resume(returning: status) } else if let status { early[serial] = status }
    }

    func wait(_ serial: UInt16, timeoutMs: Int) async -> R1AckStatus? {
        if let s = early.removeValue(forKey: serial) { return s }
        let timer = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000) } catch { return }
            self?.resolve(serial, nil)
        }
        defer { timer.cancel() }
        return await withCheckedContinuation { c in waiting[serial] = c }
    }
}

/// Fallback for when RING_CONNECT_INFO alone gives no linked status and no ring events: tell the
/// ring itself which glasses to link to, as the official app does (workbench r1_connection.dart
/// `_configure` / `_startOfficialSession` / `_sendGlassesHandoff`).
///
///   subscribe BAE80011 + BAE80013, wait 1.1 s, then on BAE80012 (write without response):
///   pair_auth (wait up to 2 s for its ack), system_time, adv_start(RIGHT lens MAC raw) (wait 4 s).
///
/// The caller then sends RING_CONNECT_INFO to the glasses (1 s later) and drops the phone -> ring link
/// (0.5 s after that), so the ring forms its controller link with the right lens.
@MainActor
public enum R1Handoff {
    public static func run(ring: BlePeripheral, glassesMacRaw: [UInt8], settleMs: Int = 1100, stepMs: Int = 300, pairAuthTimeoutMs: Int = 2000,
                           advStartTimeoutMs: Int = 4000, log: ((String) -> Void)? = nil) async throws -> R1HandoffResult {
        guard glassesMacRaw.count == 6 else { throw RingError.badMac(count: glassesMacRaw.count) }
        let acks = R1AckWaiter()
        func onData(_ source: String) -> @MainActor ([UInt8]) -> Void {
            { data in
                guard let f = R1.parse(data) else { log?("ring: RX \(source) \(hex(data))"); return }
                let kind = f.isAck ? "ack \(f.ackStatus.rawValue)" : "status 0x\(String(format: "%02x", f.status))"
                log?("ring: RX \(source) sub \(f.sub) serial \(f.serial) \(kind)\(f.transferCrcOk ? "" : " (bad CRC32C)") data \(f.data.isEmpty ? "-" : hex(f.data))")
                if f.isAck, f.transferCrcOk { acks.resolve(f.serial, f.ackStatus) }
            }
        }
        var unsubs: [@MainActor () -> Void] = []
        defer { for u in unsubs { u() } }
        for (uuid, label) in [(R1UUID.notify1, "BAE80011"), (R1UUID.notify2, "BAE80013")] where ring.has(uuid) {
            unsubs.append(try await ring.subscribe(uuid, onData(label)))
        }
        guard !unsubs.isEmpty else { throw RingError.noNotifyCharacteristic(ring.name) }
        // Let both notification subscriptions settle before pair_auth (workbench waits 1.1 s).
        if settleMs > 0 { try? await Task.sleep(nanoseconds: UInt64(settleMs) * 1_000_000) }

        var serial: UInt16 = 0
        func next() -> UInt16 { serial = (serial + 1) & 0xFF; return serial }
        func send(_ frame: [UInt8]) async throws { try await ring.write(R1UUID.write2, frame, withoutResponse: true) }

        let authSerial = next()
        try await send(R1.pairAuth(serial: authSerial))
        let auth = await acks.wait(authSerial, timeoutMs: pairAuthTimeoutMs).map(R1AckOutcome.ack) ?? .timeout
        log?("ring: pair_auth ack \(auth)")
        try await send(R1.systemTime(serial: next()))
        log?("ring: system_time sent")
        if stepMs > 0 { try? await Task.sleep(nanoseconds: UInt64(stepMs) * 1_000_000) }
        let advSerial = next()
        try await send(try R1.advStart(glassesMacRaw: glassesMacRaw, serial: advSerial))
        let adv = await acks.wait(advSerial, timeoutMs: advStartTimeoutMs).map(R1AckOutcome.ack) ?? .timeout
        log?("ring: adv_start(R \(formatMac(glassesMacRaw))) ack \(adv)")
        return R1HandoffResult(pairAuth: auth, advStart: adv)
    }
}

public func parseMac(_ s: String) -> [UInt8]? {
    let clean = s.filter { $0 != ":" && $0 != "-" }
    guard clean.count == 12, clean.allSatisfy(\.isHexDigit) else { return nil }
    return fromHex(clean)
}

public func formatMac(_ b: [UInt8]) -> String {
    b.map { String(format: "%02X", $0) }.joined(separator: ":")
}
