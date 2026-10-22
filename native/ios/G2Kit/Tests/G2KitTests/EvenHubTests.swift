// Port of native/driver/test/evenhub.test.ts.
import Foundation
import Testing
@testable import G2Kit

@Suite struct EvenHubTests {
    static let main = TextContainer(id: 1, name: "main", x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "hi")
    static let page = PageSpec(text: [main])

    @Test func textContainerFieldLayout() {
        // 1 x, 2 y, 3 w, 4 h, 5..8 border/padding, 9 id, 10 name, 11 capture, 12 content
        #expect(hex(EvenHub.textContainerProperty(Self.main)) ==
            "0800" + "1000" + "18c004" + "20a002" + "2800300038004000" + "4801" + "52046d61696e" + "5801" + "62026869")
    }

    @Test func createPageWrapsInCmd0Field3() throws {
        let m = PbMessage(try EvenHub.createPage(Self.page, magic: 5))
        #expect(m.int(1) == 0)
        #expect(m.int(2) == 5)
        let c = try #require(m.message(3))
        #expect(c.int(1) == 1)
        #expect(c.allBytes(3).count == 1)
    }

    @Test func rebuildPageListsAndImages() throws {
        let spec = PageSpec(
            list: [ListContainer(id: 2, name: "menu", x: 0, y: 0, width: 300, height: 200, captureEvents: true, items: ["a", "b"])],
            image: [ImageContainer(id: 3, name: "pic", x: 300, y: 0, width: 200, height: 100)]
        )
        let m = PbMessage(try EvenHub.rebuildPage(spec))
        #expect(m.int(1) == 7)
        let c = try #require(m.message(7))
        #expect(c.int(1) == 2)
        let list = PbMessage(c.allBytes(2)[0])
        #expect(list.int(9) == 2)
        #expect(list.int(12) == 1)
        let items = try #require(list.message(11))
        #expect(items.int(1) == 2)
        #expect(items.allBytes(4).map { String(decoding: $0, as: UTF8.self) } == ["a", "b"])
        #expect(PbMessage(c.allBytes(4)[0]).int(5) == 3)
    }

    @Test func pageValidationMirrorsSDK() {
        var noCapture = Self.main; noCapture.captureEvents = false
        #expect(throws: PageError.self) { try EvenHub.createPage(PageSpec(text: [noCapture])) }
        var empty = Self.main; empty.content = ""
        #expect(throws: PageError.self) { try EvenHub.createPage(PageSpec(text: [empty])) }
        var long = Self.main; long.content = String(repeating: "x", count: 1001)
        #expect(throws: PageError.self) { try EvenHub.createPage(PageSpec(text: [long])) }
        #expect(throws: PageError.self) {
            try EvenHub.createPage(PageSpec(text: [Self.main], image: [ImageContainer(id: 2, x: 0, y: 0, width: 300, height: 100)]))
        }
        var dup = Self.main; dup.name = "b"; dup.captureEvents = false
        #expect(throws: PageError("duplicate container id 1")) { try EvenHub.createPage(PageSpec(text: [Self.main, dup])) }
    }

    @Test func textUpgradeCountsUTF8Bytes() throws {
        let m = PbMessage(try EvenHub.updateText(containerId: 4, content: "héllo"))
        #expect(m.int(1) == 5)
        let u = try #require(m.message(9))
        #expect(u.int(1) == 4)
        #expect(u.int(3) == 0)
        #expect(u.int(4) == 6) // UTF-8 bytes, not chars
        #expect(u.string(5) == "héllo")
    }

    @Test func heartbeatAudioImuPayloads() throws {
        #expect(hex(EvenHub.heartbeat(magic: 3)) == "080c10037200")
        #expect(hex(EvenHub.audioControl(true, magic: 1)) == "080f1001920102" + "0801")
        #expect(hex(EvenHub.audioControl(false)) == "080f1000920102" + "0800")
        let imu = PbMessage(EvenHub.imuControl(true, reportFrq: 500))
        #expect(imu.int(1) == 19)
        #expect(imu.message(20)?.int(2) == 500)
    }

    @Test func imageFragmentsShareSession() throws {
        let msgs = EvenHub.imageMessages(containerId: 7, bmp: [UInt8](repeating: 1, count: 10000), sessionId: 42, containerName: "img")
        #expect(msgs.count == 3)
        let frags = msgs.map { PbMessage($0).message(5)! }
        #expect(frags.map { $0.int(3) } == [42, 42, 42])
        #expect(frags.map { $0.int(6) } == [0, 1, 2])
        #expect(frags.map { $0.int(7) } == [4096, 4096, 1808])
        #expect(frags.map { $0.int(4) } == [10000, 10000, 10000])
        #expect(frags[0].string(2) == "img")
    }

    // ---- glasses -> host. Fixtures: payload hex strings MentraOS G2.kt matches on real traffic.

    @Test func heartbeatAck() {
        #expect(parseHubPayload(fromHex("080C7A02100C")) == [.heartbeatAck(count: nil)])
    }

    @Test func textUpgradeAck() {
        #expect(parseHubPayload(fromHex("080652020808")) == [.result(cmd: 6, code: 8, sessionId: nil, fragmentIndex: nil)])
    }

    private func sysEvent(_ fields: PbWriter) -> [UInt8] {
        PbWriter().int(1, 2).int(2, 0).message(13, PbWriter().message(3, fields)).finish()
    }

    @Test func ringDoubleTap() {
        #expect(parseHubPayload(sysEvent(PbWriter().int(1, 3).int(2, 2))) == [.input(InputEvent(gesture: .doubleTap, source: .ring, via: .sys))])
    }

    @Test func emptySysEventIsClickAndLeftTempleIs3() {
        #expect(parseHubPayload(sysEvent(PbWriter().int(2, 3))) == [.input(InputEvent(gesture: .tap, source: .glassesLeft, via: .sys))])
    }

    @Test func longPressAndRelease() {
        #expect(parseHubPayload(sysEvent(PbWriter().int(1, 9).int(2, 1))) == [.input(InputEvent(gesture: .longPress, source: .glassesRight, via: .sys))])
        #expect(parseHubPayload(sysEvent(PbWriter().int(1, 10).int(2, 1))) == [.input(InputEvent(gesture: .longPressRelease, source: .glassesRight, via: .sys))])
    }

    @Test func imuReportWithFixed32Floats() {
        let imu = PbWriter().float(1, 0.5).float(2, -0.25).float(3, 1)
        #expect(parseHubPayload(sysEvent(PbWriter().int(1, 8).message(3, imu))) == [.imu(x: 0.5, y: -0.25, z: 1)])
    }

    @Test func textAndListItemEvents() {
        let text = PbWriter().int(1, 2).message(13, PbWriter().message(2, PbWriter().int(1, 4).string(2, "main").int(3, 1))).finish()
        #expect(parseHubPayload(text) == [.input(InputEvent(gesture: .scrollUp, source: .unknown, via: .text, containerId: 4, containerName: "main"))])
        let list = PbWriter().int(1, 2).message(13, PbWriter().message(1, PbWriter().int(1, 2).string(2, "menu").string(3, "b").int(4, 1))).finish()
        #expect(parseHubPayload(list) == [.input(InputEvent(gesture: .tap, source: .unknown, via: .list, containerId: 2, containerName: "menu", itemIndex: 1, itemName: "b"))])
    }

    @Test func imageFragmentAck() {
        let ack = PbWriter().int(1, 4).int(2, 0).message(6, PbWriter().int(1, 7).int(3, 42).int(6, 2).int(8, 4)).finish()
        #expect(parseHubPayload(ack) == [.result(cmd: 4, code: 4, sessionId: 42, fragmentIndex: 2)])
    }

    @Test func menuSelection() {
        #expect(parseHubPayload(PbWriter().int(1, 17).message(20, PbWriter().int(1, 9)).finish()) == [.menuSelect(appId: 9)])
    }

    @Test func deviceSettingsAuthAndBattery() {
        #expect(parseDevPayload(PbWriter().int(1, 4).int(2, 1).message(3, PbWriter().int(1, 1)).finish()) == .auth(ok: true))
        let info = PbWriter().int(1, 2).int(2, 1).message(4, PbWriter().string(5, "2.2.20").string(6, "2.2.20").int(12, 87).int(13, 1)).finish()
        #expect(parseSettingPayload(info) == DeviceInfo(battery: 87, charging: true, firmwareLeft: "2.2.20", firmwareRight: "2.2.20"))
    }
}
