// G2 / R1 BLE constants. Swift port of native/driver/src/constants.ts.
//
// Protocol facts collected from MentraOS G2.kt / G2.swift / R1.kt (Apache-2.0), men-g2-ble-gateway
// (MIT), i-soxi/even-g2-protocol docs and g2-kit-unofficial (MIT). See native/PROTOCOL.md for the
// confidence of each item. Independent reimplementation; no code copied verbatim.

import Foundation

/// GATT layout of EACH lens (left and right arms are separate BLE peripherals).
///
/// The characteristics live under several GATT services (5401/5402 under 5450, 6401/6402 under 6450,
/// 7401/7402 under 7450), so discovery must walk every service (workbench g2_protocol.dart, MentraOS
/// `discoverServices(nil)`). `…0000` is only the UUID the lenses advertise.
public enum G2UUID {
    static func base(_ suffix: String) -> String { "00002760-08C2-11E1-9073-0E8AC72E\(suffix)" }
    /// UUID the lenses advertise. It is NOT the GATT parent service of the characteristics below on
    /// current firmware; do not discover or retrieve by it alone.
    public static let advertisedService = base("0000")
    @available(*, deprecated, renamed: "advertisedService", message: "only the advertised UUID, not a GATT service")
    public static let service = advertisedService
    /// GATT service holding `write` (5401) and `notify` (5402).
    public static let controlService = base("5450")
    /// GATT service holding the render write (6401) and `audioNotify` (6402).
    public static let audioService = base("6450")
    /// Even File Service, holding `fileWrite` (7401) and `fileNotify` (7402).
    public static let fileService = base("7450")
    /// Nordic UART; some system-held lenses are indexed under it. Shared by unrelated products.
    static let nordicUartService = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
    /// host -> glasses, write-without-response, framed packets.
    public static let write = base("5401")
    /// glasses -> host, notify, framed packets (acks, events, battery...).
    public static let notify = base("5402")
    /// glasses -> host, notify, raw LC3 mic audio (NOT framed).
    public static let audioNotify = base("6402")
    /// Even File Service (notifications / file push); unused by this driver.
    public static let fileWrite = base("7401")
    public static let fileNotify = base("7402")
}

public enum R1UUID {
    public static let service = "BAE80001-4F05-4503-8E65-3AF1F7329D1F"
    public static let write1 = "BAE80010-4F05-4503-8E65-3AF1F7329D1F"
    public static let notify1 = "BAE80011-4F05-4503-8E65-3AF1F7329D1F"
    public static let write2 = "BAE80012-4F05-4503-8E65-3AF1F7329D1F"
    public static let notify2 = "BAE80013-4F05-4503-8E65-3AF1F7329D1F"
    public static let batteryService = "180F"
    public static let batteryLevel = "2A19"
}

/// Packet framing.
public enum Frame {
    public static let magic: UInt8 = 0xAA
    /// byte 1 = (dest << 4) | src. Phone = 1, glasses = 2.
    public static let phoneToGlasses: UInt8 = 0x21
    public static let glassesToPhone: UInt8 = 0x12
    public static let headerLen = 8
    public static let crcLen = 2
    /// Max protobuf bytes per BLE packet used by MentraOS (fits a 247 MTU with header + CRC).
    public static let maxChunk = 236
    /// Byte 7 for every service except device-settings (0x80).
    public static let reserveFlag: UInt8 = 0x20
}

/// Service IDs (byte 6 of the header).
public enum Service {
    public static let dashboard: UInt8 = 0x01
    public static let menu: UInt8 = 0x03
    public static let notification: UInt8 = 0x04
    public static let evenAi: UInt8 = 0x07
    public static let navigation: UInt8 = 0x08
    public static let g2Setting: UInt8 = 0x09
    public static let gestureCtrl: UInt8 = 0x0D
    public static let onboarding: UInt8 = 0x10
    public static let deviceSettings: UInt8 = 0x80
    public static let evenHubCtrl: UInt8 = 0x81
    public static let fileCmd: UInt8 = 0xC4
    public static let fileData: UInt8 = 0xC5
    public static let evenHub: UInt8 = 0xE0
}

/// evenhub_main_msg_ctx.Cmd (EvenHub_Cmd_List).
public enum HubCmd {
    public static let createStartupPage = 0
    public static let createStartupPageResponse = 1
    public static let osNotifyEvent = 2
    public static let updateImageRawData = 3
    public static let imageRawDataResponse = 4
    public static let updateTextData = 5
    public static let textDataResponse = 6
    public static let rebuildPage = 7
    public static let rebuildPageResponse = 8
    public static let shutdownPage = 9
    public static let shutdownPageResponse = 10
    public static let osPrivateEvent = 11
    public static let heartbeat = 12
    public static let heartbeatResponse = 13
    public static let osPrivateSystemEvent = 14
    public static let audioControl = 15
    public static let audioControlResponse = 16
    public static let osNotifyMenuStartup = 17
    public static let appResponseMenuStartupFailed = 18
    public static let imuControl = 19
    public static let imuControlResponse = 20
}

/// Field numbers inside evenhub_main_msg_ctx that carry each sub-message.
public enum HubField {
    public static let cmd = 1
    public static let magicRandom = 2
    public static let createMessage = 3
    public static let startupResponse = 4
    public static let imageRawData = 5
    public static let imageResponse = 6
    public static let rebuildContainer = 7
    public static let rebuildResponse = 8
    public static let textUpgrade = 9
    public static let textResponse = 10
    public static let shutdown = 11
    public static let shutdownResponse = 12
    public static let deviceEvent = 13
    public static let heartbeat = 14
    public static let heartbeatResponse = 15
    public static let audioControl = 18
    public static let audioResponse = 19
    public static let menuStartEvent = 20
    /// IMU control slot: 20 per MentraOS (on-device evidence); the g2-kit descriptor says 22.
    public static let imuControl = 20
}

/// OsEventTypeList.
public enum OsEvent {
    public static let click = 0
    public static let scrollTop = 1
    public static let scrollBottom = 2
    public static let doubleClick = 3
    public static let foregroundEnter = 4
    public static let foregroundExit = 5
    public static let abnormalExit = 6
    public static let systemExit = 7
    public static let imuDataReport = 8
    public static let longPress = 9
    public static let longPressRelease = 10
}

/// EventSourceType.
public enum EventSourceCode {
    public static let none = 0
    public static let glassesRight = 1
    public static let ring = 2
    public static let glassesLeft = 3
}

/// EvenHub_ErrorCode_List.
public enum HubResult {
    public static let createSuccess = 0
    public static let createInvalidContainer = 1
    public static let createOversize = 2
    public static let createOutOfMemory = 3
    public static let imageSuccess = 4
    public static let imageFailed = 5
    public static let rebuildSuccess = 6
    public static let rebuildFailed = 7
    public static let textSuccess = 8
    public static let textFailed = 9
    public static let shutdownSuccess = 10
    public static let shutdownFailed = 11
    public static let heartbeatSuccess = 12
    public static let audioSuccess = 13
    public static let audioFailed = 14
}

/// dev_config_protocol.proto commandId (service 0x80).
public enum DevCmd {
    public static let authentication = 4
    public static let pipeRoleChange = 5
    public static let ringConnectInfo = 6
    public static let heartbeat = 14
    public static let timeSync = 128
}

/// g2_setting.proto commandId (service 0x09).
public enum SettingCmd {
    public static let deviceReceiveInfo = 1
    public static let deviceReceiveRequest = 2
    public static let deviceSendToApp = 3
    public static let deviceRespondToApp = 4
}

/// Display / page limits (Even Hub SDK docs + MentraOS).
public enum Display {
    public static let width = 576
    public static let height = 288
    public static let grayLevels = 16
    public static let maxContainers = 12
    public static let maxTextOrListContainers = 8
    public static let maxImageContainers = 4
    public static let containerNameMax = 16
    public static let imageMinW = 20
    public static let imageMaxW = 288
    public static let imageMinH = 20
    public static let imageMaxH = 144
    public static let textMaxBytes = 1000
    public static let imageFragmentBytes = 4096
}

/// Mic stream: LC3, 16 kHz mono, 10 ms frames of 40 bytes (32 kbps), 5 frames per notification.
public enum AudioFormat {
    public static let sampleRate = 16000
    public static let frameMs = 10
    public static let frameBytes = 40
    public static let framesPerPacket = 5
    public static let samplesPerFrame = 160
}
