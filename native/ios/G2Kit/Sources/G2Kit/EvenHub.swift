// EvenHub (service 0xE0) messages: the page/container UI, text and image updates, mic and IMU
// control, heartbeat, and the events the glasses send back.
// Port of native/driver/src/messages/evenhub.ts. Field numbers from EvenHub.proto as recovered by
// MentraOS (G2.kt, Apache-2.0) and g2-kit-unofficial (MIT). Field ORDER follows G2.kt.

import Foundation

// MARK: - containers

public struct TextContainer: Equatable, Codable {
    public var id: Int
    public var name: String?
    public var x: Int, y: Int, width: Int, height: Int
    public var borderWidth = 0
    /// 0..15 grey level (green on the lens).
    public var borderColor = 0
    public var borderRadius = 0
    public var paddingLength = 0
    /// Exactly one container per page must capture input (text or list).
    public var captureEvents = false
    public var content: String?

    public init(id: Int, name: String? = nil, x: Int, y: Int, width: Int, height: Int, borderWidth: Int = 0, borderColor: Int = 0,
                borderRadius: Int = 0, paddingLength: Int = 0, captureEvents: Bool = false, content: String? = nil) {
        self.id = id; self.name = name; self.x = x; self.y = y; self.width = width; self.height = height
        self.borderWidth = borderWidth; self.borderColor = borderColor; self.borderRadius = borderRadius
        self.paddingLength = paddingLength; self.captureEvents = captureEvents; self.content = content
    }
}

public struct ListContainer: Equatable, Codable {
    public var id: Int
    public var name: String?
    public var x: Int, y: Int, width: Int, height: Int
    public var borderWidth = 0
    public var borderColor = 0
    public var borderRadius = 0
    public var paddingLength = 0
    public var captureEvents = false
    public var items: [String]
    public var itemWidth = 0
    /// Draw a border around the selected item (default true).
    public var selectBorder = true

    public init(id: Int, name: String? = nil, x: Int, y: Int, width: Int, height: Int, borderWidth: Int = 0, borderColor: Int = 0,
                borderRadius: Int = 0, paddingLength: Int = 0, captureEvents: Bool = false, items: [String], itemWidth: Int = 0,
                selectBorder: Bool = true) {
        self.id = id; self.name = name; self.x = x; self.y = y; self.width = width; self.height = height
        self.borderWidth = borderWidth; self.borderColor = borderColor; self.borderRadius = borderRadius
        self.paddingLength = paddingLength; self.captureEvents = captureEvents; self.items = items
        self.itemWidth = itemWidth; self.selectBorder = selectBorder
    }
}

public struct ImageContainer: Equatable, Codable {
    public var id: Int
    public var name: String?
    public var x: Int, y: Int, width: Int, height: Int

    public init(id: Int, name: String? = nil, x: Int, y: Int, width: Int, height: Int) {
        self.id = id; self.name = name; self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public struct PageSpec: Equatable, Codable {
    public var text: [TextContainer]
    public var list: [ListContainer]
    public var image: [ImageContainer]

    public init(text: [TextContainer] = [], list: [ListContainer] = [], image: [ImageContainer] = []) {
        self.text = text; self.list = list; self.image = image
    }
}

public struct PageError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum EvenHub {
    private static func box(_ w: PbWriter, _ x: Int, _ y: Int, _ width: Int, _ height: Int, _ bw: Int, _ bc: Int, _ br: Int, _ pad: Int) -> PbWriter {
        w.int(1, x).int(2, y).int(3, width).int(4, height).int(5, bw).int(6, bc).int(7, br).int(8, pad)
    }

    public static func textContainerProperty(_ c: TextContainer) -> [UInt8] {
        let w = box(PbWriter(), c.x, c.y, c.width, c.height, c.borderWidth, c.borderColor, c.borderRadius, c.paddingLength).int(9, c.id)
        if let name = c.name { w.string(10, name) }
        w.int(11, c.captureEvents ? 1 : 0)
        if let content = c.content { w.string(12, content) }
        return w.finish()
    }

    /// ListContainerProperty. Wire layout from the EvenHub.proto descriptor; NOT yet exercised by MentraOS.
    public static func listContainerProperty(_ c: ListContainer) -> [UInt8] {
        let item = PbWriter().int(1, c.items.count).int(2, c.itemWidth).int(3, c.selectBorder ? 1 : 0)
        for name in c.items { item.string(4, name) }
        let w = box(PbWriter(), c.x, c.y, c.width, c.height, c.borderWidth, c.borderColor, c.borderRadius, c.paddingLength).int(9, c.id)
        if let name = c.name { w.string(10, name) }
        w.message(11, item)
        w.int(12, c.captureEvents ? 1 : 0)
        return w.finish()
    }

    public static func imageContainerProperty(_ c: ImageContainer) -> [UInt8] {
        let w = PbWriter().int(1, c.x).int(2, c.y).int(3, c.width).int(4, c.height).int(5, c.id)
        if let name = c.name { w.string(6, name) }
        return w.finish()
    }

    /// Same rules the Even Hub SDK and MentraOS enforce; the firmware silently drops invalid pages.
    public static func validatePage(_ p: PageSpec) throws {
        let total = p.text.count + p.list.count + p.image.count
        if total == 0 { throw PageError("page needs at least one container") }
        if total > Display.maxContainers { throw PageError("max \(Display.maxContainers) containers per page") }
        if p.text.count + p.list.count > Display.maxTextOrListContainers {
            throw PageError("max \(Display.maxTextOrListContainers) text+list containers")
        }
        if p.image.count > Display.maxImageContainers { throw PageError("max \(Display.maxImageContainers) image containers") }
        let all: [(id: Int, name: String?, x: Int, y: Int, w: Int, h: Int)] =
            p.text.map { ($0.id, $0.name, $0.x, $0.y, $0.width, $0.height) } +
            p.list.map { ($0.id, $0.name, $0.x, $0.y, $0.width, $0.height) } +
            p.image.map { ($0.id, $0.name, $0.x, $0.y, $0.width, $0.height) }
        var ids = Set<Int>(), names = Set<String>()
        for c in all {
            if ids.contains(c.id) { throw PageError("duplicate container id \(c.id)") }
            ids.insert(c.id)
            if let n = c.name {
                if n.count > Display.containerNameMax { throw PageError("container name too long: \(n)") }
                if names.contains(n) { throw PageError("duplicate container name \(n)") }
                names.insert(n)
            }
            if c.x < 0 || c.y < 0 || c.x + c.w > Display.width || c.y + c.h > Display.height {
                throw PageError("container \(c.id) is outside the 576x288 canvas")
            }
        }
        for c in p.text {
            if c.content == "" { throw PageError("empty text is rejected by the firmware; use a single space") }
            if let s = c.content, s.utf8.count > Display.textMaxBytes {
                throw PageError("text container \(c.id) content exceeds \(Display.textMaxBytes) UTF-8 bytes")
            }
        }
        for c in p.image where c.width < Display.imageMinW || c.width > Display.imageMaxW || c.height < Display.imageMinH || c.height > Display.imageMaxH {
            throw PageError("image container \(c.id) must be 20..288 x 20..144")
        }
        let captures = p.text.filter(\.captureEvents).count + p.list.filter(\.captureEvents).count
        if captures != 1 { throw PageError("exactly one text or list container must have captureEvents") }
    }

    /// CreateStartUpPageContainer / RebuildPageContainer body (same layout).
    public static func pageContainer(_ p: PageSpec) throws -> [UInt8] {
        try validatePage(p)
        let w = PbWriter().int(1, p.text.count + p.list.count + p.image.count)
        for c in p.list { w.message(2, listContainerProperty(c)) }
        // G2.kt ordering: text (field 3) before images (field 4).
        for c in p.text { w.message(3, textContainerProperty(c)) }
        for c in p.image { w.message(4, imageContainerProperty(c)) }
        return w.finish()
    }

    // MARK: top-level wrapper

    public static func hubMessage(cmd: Int, subField: Int, sub: [UInt8], magic: UInt8 = 0, appId: Int? = nil) -> [UInt8] {
        let w = PbWriter().int(HubField.cmd, cmd).int(HubField.magicRandom, Int(magic)).message(subField, sub)
        if let appId { w.int(5, appId) }
        return w.finish()
    }

    public static func createPage(_ p: PageSpec, magic: UInt8 = 0) throws -> [UInt8] {
        hubMessage(cmd: HubCmd.createStartupPage, subField: HubField.createMessage, sub: try pageContainer(p), magic: magic)
    }

    public static func rebuildPage(_ p: PageSpec, magic: UInt8 = 0) throws -> [UInt8] {
        hubMessage(cmd: HubCmd.rebuildPage, subField: HubField.rebuildContainer, sub: try pageContainer(p), magic: magic)
    }

    /// TextContainerUpgrade: replace `length` bytes at `offset` (MentraOS always sends offset 0, full length).
    public static func updateText(containerId: Int, content: String, offset: Int = 0, length: Int? = nil, magic: UInt8 = 0) throws -> [UInt8] {
        if content.isEmpty { throw PageError("empty text is rejected by the firmware; use a single space") }
        let bytes = content.utf8.count
        if bytes > Display.textMaxBytes { throw PageError("text exceeds \(Display.textMaxBytes) UTF-8 bytes") }
        let sub = PbWriter().int(1, containerId).int(3, offset).int(4, length ?? bytes).string(5, content).finish()
        return hubMessage(cmd: HubCmd.updateTextData, subField: HubField.textUpgrade, sub: sub, magic: magic)
    }

    public static func imageFragment(containerId: Int, containerName: String?, sessionId: Int, totalSize: Int, index: Int, data: [UInt8]) -> [UInt8] {
        let w = PbWriter().int(1, containerId)
        if let containerName { w.string(2, containerName) }
        w.int(3, sessionId).int(4, totalSize).int(5, 0).int(6, index).int(7, data.count).bytes(8, data)
        return hubMessage(cmd: HubCmd.updateImageRawData, subField: HubField.imageRawData, sub: w.finish())
    }

    /// Split a BMP into ImageRawDataUpdate messages (4096-byte fragments, one session id for the whole image).
    public static func imageMessages(containerId: Int, bmp: [UInt8], sessionId: Int, containerName: String? = nil) -> [[UInt8]] {
        stride(from: 0, to: bmp.count, by: Display.imageFragmentBytes).enumerated().map { i, off in
            imageFragment(containerId: containerId, containerName: containerName, sessionId: sessionId, totalSize: bmp.count,
                          index: i, data: Array(bmp[off..<min(off + Display.imageFragmentBytes, bmp.count)]))
        }
    }

    public static func shutdownPage(exitMode: Int = 0) -> [UInt8] {
        hubMessage(cmd: HubCmd.shutdownPage, subField: HubField.shutdown, sub: PbWriter().int(1, exitMode).finish())
    }

    public static func heartbeat(magic: UInt8 = 0) -> [UInt8] {
        hubMessage(cmd: HubCmd.heartbeat, subField: HubField.heartbeat, sub: [], magic: magic)
    }

    public static func audioControl(_ enable: Bool, magic: UInt8 = 0) -> [UInt8] {
        hubMessage(cmd: HubCmd.audioControl, subField: HubField.audioControl, sub: PbWriter().int(1, enable ? 1 : 0).finish(), magic: magic)
    }

    /// reportFrq is a pacing code 100..1000 (step 100), not Hz.
    public static func imuControl(_ enable: Bool, reportFrq: Int = 100, magic: UInt8 = 0) -> [UInt8] {
        hubMessage(cmd: HubCmd.imuControl, subField: HubField.imuControl,
                   sub: PbWriter().int(1, enable ? 1 : 0).int(2, reportFrq).finish(), magic: magic)
    }
}

// MARK: - glasses -> host

public enum Gesture: String, Codable, Equatable {
    case tap, doubleTap = "double_tap", scrollUp = "scroll_up", scrollDown = "scroll_down"
    case longPress = "long_press", longPressRelease = "long_press_release"
    case foregroundEnter = "foreground_enter", foregroundExit = "foreground_exit"
    case abnormalExit = "abnormal_exit", systemExit = "system_exit"

    init?(osEvent: Int) {
        switch osEvent {
        case OsEvent.click: self = .tap
        case OsEvent.scrollTop: self = .scrollUp
        case OsEvent.scrollBottom: self = .scrollDown
        case OsEvent.doubleClick: self = .doubleTap
        case OsEvent.foregroundEnter: self = .foregroundEnter
        case OsEvent.foregroundExit: self = .foregroundExit
        case OsEvent.abnormalExit: self = .abnormalExit
        case OsEvent.systemExit: self = .systemExit
        case OsEvent.longPress: self = .longPress
        case OsEvent.longPressRelease: self = .longPressRelease
        default: return nil
        }
    }

    /// The SDK's OsEventTypeList value (CLICK is reported as nil, as the SDK normalises 0 away).
    public var sdkEventType: Int? {
        switch self {
        case .tap: return nil
        case .scrollUp: return 1
        case .scrollDown: return 2
        case .doubleTap: return 3
        case .foregroundEnter: return 4
        case .foregroundExit: return 5
        case .abnormalExit: return 6
        case .systemExit: return 7
        case .longPress: return 9
        case .longPressRelease: return 10
        }
    }
}

public enum InputSource: String, Codable, Equatable {
    case glassesRight = "glasses_right", glassesLeft = "glasses_left", ring, unknown

    init(code: Int) {
        switch code {
        case EventSourceCode.glassesRight: self = .glassesRight
        case EventSourceCode.glassesLeft: self = .glassesLeft
        case EventSourceCode.ring: self = .ring
        default: self = .unknown
        }
    }

    /// SDK EventSourceType value.
    public var sdkCode: Int {
        switch self {
        case .unknown: return 0
        case .glassesRight: return 1
        case .ring: return 2
        case .glassesLeft: return 3
        }
    }
}

public enum InputVia: String, Equatable { case sys, text, list }

public struct InputEvent: Equatable {
    public var gesture: Gesture
    public var source: InputSource
    public var via: InputVia
    public var containerId: Int?
    public var containerName: String?
    public var itemIndex: Int?
    public var itemName: String?

    public init(gesture: Gesture, source: InputSource, via: InputVia, containerId: Int? = nil, containerName: String? = nil,
                itemIndex: Int? = nil, itemName: String? = nil) {
        self.gesture = gesture; self.source = source; self.via = via; self.containerId = containerId
        self.containerName = containerName; self.itemIndex = itemIndex; self.itemName = itemName
    }
}

public enum HubEvent: Equatable {
    case input(InputEvent)
    case imu(x: Float, y: Float, z: Float)
    case result(cmd: Int, code: Int, sessionId: Int?, fragmentIndex: Int?)
    case heartbeatAck(count: Int?)
    case audioAck(state: Int?)
    case menuSelect(appId: Int)
    case pageClosed(cmd: Int)
    /// A Sys event from the ring (source 2) with no type field. Proto3 drops CLICK (0), so this is
    /// how a ring tap is encoded, but the firmware also sends this shape as an activity marker
    /// around a hold it consumes itself (workbench G2_R1_HUB_LONG_PRESS.md). Always followed by
    /// the `.input(tap)` it decodes to, as MentraOS and workbench both still treat it as a tap.
    case ringActivity
    case unknown(cmd: Int?, payload: [UInt8])
}

/// Decode one reassembled EvenHub payload from the glasses.
public func parseHubPayload(_ payload: [UInt8]) -> [HubEvent] {
    let m = PbMessage(payload)
    let cmd = m.int(HubField.cmd)
    if cmd == HubCmd.osNotifyEvent { return parseDeviceEvent(m.message(HubField.deviceEvent)) }
    if cmd == HubCmd.heartbeatResponse || m.has(HubField.heartbeatResponse) {
        return [.heartbeatAck(count: m.message(HubField.heartbeatResponse)?.int(1))]
    }
    if cmd == HubCmd.osNotifyMenuStartup {
        guard let appId = m.message(HubField.menuStartEvent)?.int(1) else { return [] }
        return [.menuSelect(appId: appId)]
    }
    if cmd == HubCmd.audioControlResponse { return [.audioAck(state: m.message(HubField.audioResponse)?.int(1))] }

    var out: [HubEvent] = []
    for f in [HubField.startupResponse, HubField.imageResponse, HubField.rebuildResponse, HubField.textResponse, HubField.shutdownResponse] {
        guard let r = m.message(f) else { continue }
        if f == HubField.imageResponse {
            // ResponseImageRawDataCmd: 3 = MapSessionId, 6 = MapFragmentIndex, 8 = ErrorCode.
            out.append(.result(cmd: cmd ?? -1, code: r.int(8) ?? 0, sessionId: r.int(3), fragmentIndex: r.int(6)))
        } else {
            out.append(.result(cmd: cmd ?? -1, code: r.int(1) ?? 0, sessionId: nil, fragmentIndex: nil))
        }
    }
    if let cmd, cmd == HubCmd.shutdownPage || cmd == HubCmd.shutdownPageResponse { out.append(.pageClosed(cmd: cmd)) }
    if out.isEmpty { out.append(.unknown(cmd: cmd, payload: payload)) }
    return out
}

private func parseDeviceEvent(_ ev: PbMessage?) -> [HubEvent] {
    guard let ev else { return [] }
    // SendDeviceEvent: 1 = List_ItemEvent, 2 = Text_ItemEvent, 3 = Sys_ItemEvent
    if let sys = ev.message(3) {
        let typeField = sys.int(1)
        let type = typeField ?? OsEvent.click // proto3 omits 0, so a missing type is a CLICK
        if type == OsEvent.imuDataReport, let imu = sys.message(3) {
            guard let x = imu.float(1), let y = imu.float(2), let z = imu.float(3) else { return [] }
            return [.imu(x: x, y: y, z: z)]
        }
        guard let g = Gesture(osEvent: type) else { return [] }
        let source = InputSource(code: sys.int(2) ?? 0)
        let input = HubEvent.input(InputEvent(gesture: g, source: source, via: .sys))
        // Ring + no type: report the activity marker, and still deliver the tap (see .ringActivity).
        if typeField == nil && source == .ring { return [.ringActivity, input] }
        return [input]
    }
    if let text = ev.message(2) {
        guard let g = Gesture(osEvent: text.int(3) ?? OsEvent.click) else { return [] }
        return [.input(InputEvent(gesture: g, source: .unknown, via: .text, containerId: text.int(1), containerName: text.string(2)))]
    }
    if let list = ev.message(1) {
        guard let g = Gesture(osEvent: list.int(5) ?? OsEvent.click) else { return [] }
        return [.input(InputEvent(gesture: g, source: .unknown, via: .list, containerId: list.int(1), containerName: list.string(2),
                                  itemIndex: list.int(4) ?? 0, itemName: list.string(3)))]
    }
    return []
}
