// Device-settings (service 0x80, "dev_config") and G2-setting (service 0x09) messages: the
// session handshake, heartbeat, time sync, ring binding, battery/firmware query, brightness; plus
// the onboarding (0x10) / gesture_ctrl (0x0D) session-init messages and the ring status replies.
// Port of native/driver/src/messages/device.ts.
//
// WARNING (g2-kit-unofficial gotchas.md): unknown dev_config fields once soft-bricked a pair until a
// power cycle. Only the messages below are known-good; do not experiment on service 0x80.

import Foundation

/// AuthMgr.phoneType (dev_pair_manager.eDevice).
public enum PhoneType {
    public static let ios = 3
    public static let android = 4
    /// Builder default: PHONE_IOS on iOS; elsewhere (the macOS test host) the Android value of the
    /// i-soxi capture the framing tests pin. G2Driver always sends DriverOptions.phoneType (3).
    #if os(iOS)
    public static let platformDefault = ios
    #else
    public static let platformDefault = android
    #endif
}

public enum DevConfig {
    /// AUTHENTICATION: {1: 4, 2: magic, 3: {1: true, 2: phoneType}}. Sent to EACH lens.
    /// phoneType 3 = PHONE_IOS (MentraOS G2.swift; workbench `isIos ? 3 : 4`), 4 = PHONE_ANDROID.
    public static func auth(magic: UInt8, phoneType: Int = PhoneType.platformDefault) -> [UInt8] {
        PbWriter().int(1, DevCmd.authentication).int(2, Int(magic)).message(3, PbWriter().bool(1, true).int(2, phoneType)).finish()
    }

    /// PIPE_ROLE_CHANGE: MentraOS sends role 1 to the right lens; the i-soxi Even App capture shows 2.
    public static func pipeRoleChange(magic: UInt8, role: Int = 1) -> [UInt8] {
        PbWriter().int(1, DevCmd.pipeRoleChange).int(2, Int(magic)).message(4, PbWriter().int(1, role)).finish()
    }

    /// TIME_SYNC (field 128). The dashboard clock treats the timestamp as wall-clock seconds, so
    /// MentraOS sends local time folded into the epoch and offset 0.
    public static func timeSync(magic: UInt8, now: Date = Date(), timeZone: TimeZone = .current) -> [UInt8] {
        let local = Int(now.timeIntervalSince1970.rounded(.down)) + timeZone.secondsFromGMT(for: now)
        return PbWriter().int(1, DevCmd.timeSync).int(2, Int(magic)).message(128, PbWriter().int(1, local).int(2, 0)).finish()
    }

    public static func heartbeat(magic: UInt8) -> [UInt8] {
        PbWriter().int(1, DevCmd.heartbeat).int(2, Int(magic)).message(13, [UInt8]()).finish()
    }

    /// RING_CONNECT_INFO: tell the glasses to (dis)connect the R1 ring with this MAC.
    /// `ringMac` is the 6 bytes in RAW advertisement order (the last 6 bytes of the ring's full
    /// manufacturer data), NOT reversed: MentraOS keeps that order end to end.
    /// Wire: 08 06 10 <m> 2a <len> 08 01 12 06 <mac6> [1a <n> <name>].
    public static func ringConnectInfo(magic: UInt8, connect: Bool, ringMac: [UInt8], ringName: String = "") -> [UInt8] {
        precondition(ringMac.count == 6, "ring MAC must be 6 bytes")
        let ring = PbWriter().bool(1, connect).bytes(2, ringMac)
        if !ringName.isEmpty { ring.string(3, ringName) }
        return PbWriter().int(1, DevCmd.ringConnectInfo).int(2, Int(magic)).message(5, ring).finish()
    }

    // MARK: service 0x09

    /// Ask for battery / charging / firmware. Reply arrives as DEVICE_RECEIVE_REQUEST or DEVICE_SEND_TO_APP.
    public static func requestDeviceInfo(magic: UInt8) -> [UInt8] {
        PbWriter().int(1, SettingCmd.deviceReceiveRequest).int(2, Int(magic)).message(4, PbWriter().int(1, 1)).finish()
    }

    private static func settingInfo(magic: UInt8, field: Int, _ sub: PbWriter) -> [UInt8] {
        PbWriter().int(1, SettingCmd.deviceReceiveInfo).int(2, Int(magic)).message(3, PbWriter().message(field, sub)).finish()
    }

    /// Brightness. The valid `level` range is not documented by any source (unverified).
    public static func setBrightness(magic: UInt8, level: Int, auto: Bool = false) -> [UInt8] {
        settingInfo(magic: magic, field: 1, PbWriter().int(1, auto ? 1 : 0).int(2, level))
    }

    public static func setHeadUpAngle(magic: UInt8, angle: Int) -> [UInt8] {
        settingInfo(magic: magic, field: 4, PbWriter().int(2, angle))
    }
}

/// The two non-0x80 messages both ring-capable drivers send to the RIGHT lens after TIME_SYNC
/// (MentraOS G2.swift runAuthSequence; workbench g2_connection.dart _initializeProtocol).
public enum SessionInit {
    /// Onboarding (service 0x10) CONFIG with processId FINISH: {1: 1, 2: magic, 3: {1: 4}}.
    public static func skipOnboarding(magic: UInt8) -> [UInt8] {
        PbWriter().int(1, 1).int(2, Int(magic)).message(3, PbWriter().int(1, 4)).finish()
    }

    /// gesture_ctrl (service 0x0D) init: {1: 0, 2: magic}. The 0 is written explicitly, as both do.
    public static func gestureCtrlInit(magic: UInt8) -> [UInt8] {
        PbWriter().int(1, 0).int(2, Int(magic)).finish()
    }
}

/// dev_config commands the glasses use to report the R1 link (dev_pair_manager.proto).
public enum RingCmd {
    /// RingInfo in field 5: 1 connectRing, 2 ringMac, 3 ringName, 4 connRet (connStatus), 5 result.
    public static let connectInfo = 6
    /// DisconnectInfo in field 7: 1 dev, 2 ringMac, 3 result.
    public static let disconnectInfo = 8
    /// UnpairInfo in field 8: 1 dev, 2 ringMac, 3 result.
    public static let unpairInfo = 9
}

/// What the glasses said about the ring (RING_CONNECT_INFO / DISCONNECT_INFO / UNPAIR_INFO reply).
/// Per MentraOS: connect == 1 or connStatus 62 means linked, 22 means disconnected (re-send
/// RING_CONNECT_INFO), 8 means probably disconnected; result 90 is RING_CONNECT_TIMEOUT.
public struct RingStatus: Equatable {
    public var connect: Int?
    /// Ring MAC as the glasses report it (field 2), raw order.
    public var macRaw: [UInt8]?
    public var connStatus: Int?
    public var result: Int?
    /// 6 (connect info), 8 (disconnect info) or 9 (unpair info).
    public var cmd: Int

    public init(connect: Int? = nil, macRaw: [UInt8]? = nil, connStatus: Int? = nil, result: Int? = nil, cmd: Int) {
        self.connect = connect; self.macRaw = macRaw; self.connStatus = connStatus; self.result = result; self.cmd = cmd
    }

    public static let connStatusLinked = 62
    public static let connStatusDisconnected = 22
    public static let connStatusMaybeDisconnected = 8
    public static let resultConnectTimeout = 90

    /// A RING_CONNECT_INFO reply with no field set: the glasses' acknowledgement (both lenses send
    /// one, seen 2026-10-18), not ring state. It must not replace a real status.
    public var isAckOnly: Bool { cmd == RingCmd.connectInfo && connect == nil && macRaw == nil && connStatus == nil && result == nil }

    /// The ring MAC to remember from this report, or nil. Only a RING_CONNECT_INFO reply (field 5.2)
    /// names the ring the glasses link; DISCONNECT/UNPAIR reports name one they dropped, and re-linking
    /// it would undo an unpair. A MAC that contradicts the ring's advertised name is never taken: the
    /// glasses may be echoing a wrong MAC an older build sent them.
    public func learnableMac(ringName: String?) -> [UInt8]? {
        guard cmd == RingCmd.connectInfo, let mac = macRaw, mac.count == 6 else { return nil }
        let check = RingAdvert(id: "", name: ringName ?? "", manufacturerData: [], macRaw: mac).nameCheck
        return check == .mismatch ? nil : mac
    }

    /// The glasses report the ring as linked.
    public var linked: Bool { cmd == RingCmd.connectInfo && (connect == 1 || connStatus == RingStatus.connStatusLinked) }
    /// MentraOS re-sends RING_CONNECT_INFO on this.
    public var needsRebind: Bool { cmd == RingCmd.connectInfo && connStatus == RingStatus.connStatusDisconnected }

    /// "connect=1 connStatus=62 result=0" (+ mac / meaning when known), for the ring log lines.
    public var summary: String {
        func v(_ x: Int?) -> String { x.map(String.init) ?? "-" }
        var s: String
        switch cmd {
        case RingCmd.connectInfo: s = "connect=\(v(connect)) connStatus=\(v(connStatus)) result=\(v(result))"
        case RingCmd.disconnectInfo: s = "disconnect-info result=\(v(result))"
        case RingCmd.unpairInfo: s = "unpair-info result=\(v(result))"
        default: s = "cmd=\(cmd) result=\(v(result))"
        }
        if let macRaw, macRaw.count == 6 { s += " mac \(formatMac(macRaw)) (raw)" }
        if isAckOnly { s += " (ack, no ring state)" }
        if linked { s += " (linked)" }
        else if needsRebind { s += " (disconnected: re-send RING_CONNECT_INFO)" }
        else if connStatus == RingStatus.connStatusMaybeDisconnected { s += " (probably disconnected)" }
        if result == RingStatus.resultConnectTimeout { s += " (RING_CONNECT_TIMEOUT)" }
        return s
    }
}

public enum DevEvent: Equatable {
    /// AUTH reply. `ok` is AuthMgr.secAuth, or nil when the reply carries none. On hardware each lens
    /// sends a first reply ~60 ms after AUTH that an older parser read as false, then secAuth = true
    /// (2026-10-18). MentraOS logs a reply without secAuth as "?" and reconnects only on an explicit
    /// false, so that first reply is not a rejection.
    case auth(ok: Bool?)
    case heartbeat
    /// Ring status for cmd 6 / 8 / 9.
    case ringInfo(RingStatus)
    case other(cmd: Int?)
}

/// AuthMgr.secAuth: a varint in what MentraOS sends and reads, bytes in the recovered .proto. nil when
/// the reply has no AuthMgr or no secAuth (not the same as false).
private func authVerdict(_ a: PbMessage?) -> Bool? {
    guard let a else { return nil }
    if let v = a.int(1) { return v != 0 }
    if let b = a.bytes(1), !b.isEmpty { return b.contains { $0 != 0 } }
    return nil
}

public func parseDevPayload(_ payload: [UInt8]) -> DevEvent {
    let m = PbMessage(payload)
    let cmd = m.int(1)
    if cmd == DevCmd.authentication { return .auth(ok: authVerdict(m.message(3))) }
    if cmd == DevCmd.heartbeat { return .heartbeat }
    if cmd == RingCmd.connectInfo {
        // An empty reply is an acknowledgement without state, not a disconnect (workbench).
        guard let r = m.message(5) else { return .ringInfo(RingStatus(cmd: RingCmd.connectInfo)) }
        // connectRing is a varint in what MentraOS sends and parses; the recovered .proto says bytes.
        let connect = r.int(1) ?? r.bytes(1)?.first.map(Int.init)
        return .ringInfo(RingStatus(connect: connect, macRaw: r.bytes(2), connStatus: r.int(4), result: r.int(5), cmd: RingCmd.connectInfo))
    }
    if let cmd, cmd == RingCmd.disconnectInfo || cmd == RingCmd.unpairInfo {
        let r = m.message(cmd == RingCmd.disconnectInfo ? 7 : 8)
        return .ringInfo(RingStatus(macRaw: r?.bytes(2), result: r?.int(3), cmd: cmd))
    }
    return .other(cmd: cmd)
}

public struct DeviceInfo: Equatable, Codable {
    public var battery: Int?
    public var charging: Bool?
    public var firmwareLeft: String?
    public var firmwareRight: String?
    public var silentMode: Bool?

    public init(battery: Int? = nil, charging: Bool? = nil, firmwareLeft: String? = nil, firmwareRight: String? = nil, silentMode: Bool? = nil) {
        self.battery = battery; self.charging = charging; self.firmwareLeft = firmwareLeft
        self.firmwareRight = firmwareRight; self.silentMode = silentMode
    }

    /// Fields set in `other` overwrite ours.
    public func merged(with other: DeviceInfo) -> DeviceInfo {
        DeviceInfo(battery: other.battery ?? battery, charging: other.charging ?? charging,
                   firmwareLeft: other.firmwareLeft ?? firmwareLeft, firmwareRight: other.firmwareRight ?? firmwareRight,
                   silentMode: other.silentMode ?? silentMode)
    }
}

public func parseSettingPayload(_ payload: [UInt8]) -> DeviceInfo? {
    let m = PbMessage(payload)
    let cmd = m.int(1)
    guard cmd == SettingCmd.deviceReceiveRequest || cmd == SettingCmd.deviceSendToApp else { return nil }
    var info = DeviceInfo()
    if let r = m.message(4) {
        if let b = r.int(12), (0...100).contains(b) { info.battery = b }
        if let c = r.int(13) { info.charging = c != 0 }
        info.firmwareLeft = r.string(5)
        info.firmwareRight = r.string(6)
    }
    if let s = m.message(5)?.int(2) { info.silentMode = s != 0 }
    return info
}
