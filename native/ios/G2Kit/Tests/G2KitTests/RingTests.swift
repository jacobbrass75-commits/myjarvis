import Foundation
import Testing
@testable import G2Kit

@Suite struct RingTests {
    // MARK: advertisement / MAC

    @Test func macIsLastSixBytesOfFullManufacturerDataInRawOrder() {
        // "ER" company id, then the MAC reversed: printed 11:22:33:CE:C5:BA, name ends in CEC5BA.
        let ad = RingAdvert(id: "9F3E1234-AAAA-BBBB-CCCC-DDDDEEEEFFFF", name: "EVEN R1_CEC5BA", rssi: -61,
                            manufacturerData: [0x45, 0x52, 0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11])
        #expect(ad.macRaw == [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11])
        #expect(ad.nameCheck == .littleEndian)
        #expect(ad.mac == "11:22:33:CE:C5:BA")
        #expect(ad.logLine == "ring: seen EVEN R1_CEC5BA id 9F3E1234… rssi -61 mfr 4552bac5ce332211; mac raw BA C5 CE 33 22 11 → 11:22:33:CE:C5:BA name-check ok (LE)")
    }

    @Test func longerManufacturerDataStillUsesTheSuffix() {
        let ad = RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: [0x45, 0x52, 0x01, 0x02, 0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11])
        #expect(ad.macRaw == [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11])
    }

    @Test func currentFirmwarePutsTheMacAfterTheCompanyIdAndAppendsASerial() {
        // Captured on hardware (2026-10-21): EVEN R1_C7D8E9, scan response manufacturer data.
        let mfr = fromHex("4552e9d8c7010002423030305445535430303830303332")
        let ad = RingAdvert(id: "1A2B3C4D", name: "EVEN R1_C7D8E9", manufacturerData: mfr)
        #expect(ad.macRaw == [0xE9, 0xD8, 0xC7, 0x01, 0x00, 0x02])
        #expect(ad.nameCheck == .littleEndian)
        #expect(ad.mac == "02:00:01:C7:D8:E9")
        // The same blob for a different ring name confirms nothing: the suffix comes back unverified.
        let other = RingAdvert(id: "X", name: "EVEN R1_000000", manufacturerData: mfr)
        #expect(other.macRaw == Array(mfr.suffix(6)) && !other.nameCheck.verified)
    }

    @Test func nameCheckDetectsPrintedOrderAndMismatch() {
        let be = RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: [0x45, 0x52, 0x11, 0x22, 0x33, 0xCE, 0xC5, 0xBA])
        #expect(be.nameCheck == .bigEndian)
        #expect(be.mac == "11:22:33:CE:C5:BA")
        let bad = RingAdvert(id: "X", name: "EVEN R1_000000", manufacturerData: [0x45, 0x52, 0x11, 0x22, 0x33, 0xCE, 0xC5, 0xBA])
        #expect(bad.nameCheck == .mismatch)
        #expect(bad.logLine.contains("name-check MISMATCH"))
        let noSuffix = RingAdvert(id: "X", name: "BCL603", manufacturerData: [1, 2, 3, 4, 5, 6])
        #expect(noSuffix.nameCheck == .unknown)
    }

    @Test func onlyANameConfirmedMacIsVerified() {
        #expect(RingNameCheck.littleEndian.verified && RingNameCheck.bigEndian.verified)
        #expect(!RingNameCheck.mismatch.verified && !RingNameCheck.unknown.verified)
        // Run 2 on hardware: EVEN R1_C7D8E9's scan response carried ASCII "080032".
        let ascii = RingAdvert(id: "X", name: "EVEN R1_C7D8E9", manufacturerData: Array("080032".utf8))
        #expect(ascii.nameCheck == .mismatch && !ascii.nameCheck.verified)
        #expect(!RingAdvert(id: "X", name: "BCL603", manufacturerData: [1, 2, 3, 4, 5, 6]).nameCheck.verified)
    }

    @Test func shortOrMissingManufacturerDataHasNoMac() {
        #expect(RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: [0x45, 0x52, 1]).macRaw == nil)
        #expect(RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: []).macRaw == nil)
        #expect(RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: [], macRaw: [1, 2, 3, 4, 5, 6]).macRaw == [1, 2, 3, 4, 5, 6])
        #expect(RingAdvert(id: "X", name: "EVEN R1_CEC5BA", manufacturerData: []).logLine.hasSuffix("no MAC (manufacturer data too short)"))
    }

    @Test func ringNames() {
        #expect(RingAdvert.isRingName("EVEN R1_CEC5BA"))
        #expect(RingAdvert.isRingName("even r1_cec5ba"))
        #expect(RingAdvert.isRingName("BCL603_xyz"))
        #expect(!RingAdvert.isRingName("Even G2_32_R_1A2B3C"))
        #expect(!RingAdvert.isRingName(nil))
    }

    // MARK: glasses-side ring messages

    @Test func ringConnectInfoExactBytes() {
        let mac: [UInt8] = [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11]
        let name = hex(Array("EVEN R1_CEC5BA".utf8))
        #expect(hex(DevConfig.ringConnectInfo(magic: 3, connect: true, ringMac: mac, ringName: "EVEN R1_CEC5BA"))
            == "08061003" + "2a1a" + "0801" + "1206" + "bac5ce332211" + "1a0e" + name)
        #expect(hex(DevConfig.ringConnectInfo(magic: 3, connect: false, ringMac: mac)) == "08061003" + "2a0a" + "0800" + "1206" + "bac5ce332211")
    }

    @Test func ringStatusParsing() {
        let mac: [UInt8] = [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11]
        // connectRing as bytes (what the recovered .proto declares) is read too.
        let asBytes = PbWriter().int(1, 6).message(5, PbWriter().bytes(1, [1]).int(4, 62)).finish()
        #expect(parseDevPayload(asBytes) == .ringInfo(RingStatus(connect: 1, connStatus: 62, cmd: 6)))
        // An empty ack is not a disconnect.
        #expect(parseDevPayload(PbWriter().int(1, 6).int(2, 1).finish()) == .ringInfo(RingStatus(cmd: 6)))
        let unpair = PbWriter().int(1, 9).message(8, PbWriter().int(1, 0).bytes(2, mac).int(3, 0)).finish()
        #expect(parseDevPayload(unpair) == .ringInfo(RingStatus(macRaw: mac, result: 0, cmd: 9)))
        #expect(parseDevPayload(PbWriter().int(1, 14).int(2, 1).message(13, [UInt8]()).finish()) == .heartbeat)
        #expect(RingStatus(connect: 0, connStatus: 62, cmd: 6).linked)
        #expect(!RingStatus(connect: 0, connStatus: 8, cmd: 6).linked)
        #expect(RingStatus(result: 90, cmd: 6).summary == "connect=- connStatus=- result=90 (RING_CONNECT_TIMEOUT)")
    }

    @Test func authRepliesKeepNoVerdictApartFromFalse() {
        func reply(_ auth: PbWriter?) -> [UInt8] {
            let w = PbWriter().int(1, 4).int(2, 1)
            if let auth { w.message(3, auth) }
            return w.finish()
        }
        #expect(parseDevPayload(reply(nil)) == .auth(ok: nil))
        #expect(parseDevPayload(reply(PbWriter())) == .auth(ok: nil))
        #expect(parseDevPayload(reply(PbWriter().int(3, 0))) == .auth(ok: nil), "result alone is no verdict")
        #expect(parseDevPayload(reply(PbWriter().int(1, 0))) == .auth(ok: false))
        #expect(parseDevPayload(reply(PbWriter().int(1, 1))) == .auth(ok: true))
        // secAuth is `bytes` in the recovered .proto.
        #expect(parseDevPayload(reply(PbWriter().bytes(1, [1]))) == .auth(ok: true))
        #expect(parseDevPayload(reply(PbWriter().bytes(1, [0]))) == .auth(ok: false))
    }

    @Test func ringMacIsLearnedOnlyFromAConnectInfoThatFitsTheName() {
        let mac: [UInt8] = [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11]
        let info = RingStatus(connect: 1, macRaw: mac, connStatus: 62, cmd: RingCmd.connectInfo)
        #expect(info.learnableMac(ringName: "EVEN R1_CEC5BA") == mac)
        #expect(info.learnableMac(ringName: nil) == mac, "no name to contradict it")
        #expect(info.learnableMac(ringName: "EVEN R1_C7D8E9") == nil)
        // The wrong MAC run 2 sent the glasses must not come back through their reply.
        let echoed = RingStatus(macRaw: Array("080032".utf8), cmd: RingCmd.connectInfo)
        #expect(echoed.learnableMac(ringName: "EVEN R1_C7D8E9") == nil)
        #expect(RingStatus(macRaw: mac, result: 0, cmd: RingCmd.unpairInfo).learnableMac(ringName: "EVEN R1_CEC5BA") == nil)
        #expect(RingStatus(macRaw: mac, result: 0, cmd: RingCmd.disconnectInfo).learnableMac(ringName: nil) == nil)
        #expect(RingStatus(macRaw: [1, 2, 3], cmd: RingCmd.connectInfo).learnableMac(ringName: nil) == nil)
        #expect(RingStatus(cmd: RingCmd.connectInfo).isAckOnly && !info.isAckOnly)
        #expect(!RingStatus(cmd: RingCmd.disconnectInfo).isAckOnly)
    }

    @Test func ringSysEventWithoutTypeIsMarkerPlusTap() {
        let ev = PbWriter().int(1, 2).message(13, PbWriter().message(3, PbWriter().int(2, 2))).finish()
        #expect(parseHubPayload(ev) == [.ringActivity, .input(InputEvent(gesture: .tap, source: .ring, via: .sys))])
        // Typed ring events and untyped temple taps are unchanged.
        let typed = PbWriter().int(1, 2).message(13, PbWriter().message(3, PbWriter().int(1, 3).int(2, 2))).finish()
        #expect(parseHubPayload(typed) == [.input(InputEvent(gesture: .doubleTap, source: .ring, via: .sys))])
        let temple = PbWriter().int(1, 2).message(13, PbWriter().message(3, PbWriter().int(2, 1))).finish()
        #expect(parseHubPayload(temple) == [.input(InputEvent(gesture: .tap, source: .glassesRight, via: .sys))])
    }

    // MARK: R1 command frames

    /// Official com.even.sg captures (outer CRC verified by scratchpad tools/crcchk.py).
    let capturePairAuth = "00971953f964016401000000080d003f0101"
    let captureAdvStart = "00c50c1248640164070000000a120045c963a3a7375bd4"

    @Test func crc32cMatchesOfficialCaptures() {
        #expect(r1Crc32c(Array(fromHex(capturePairAuth)[5...])) == 0xF953_1997)
        #expect(r1Crc32c(Array(fromHex(captureAdvStart)[5...])) == 0x4812_0CC5)
        #expect(r1Crc32c([UInt8]()) == 0)
    }

    @Test func capturesDecode() throws {
        let auth = try #require(R1.parse(fromHex(capturePairAuth)))
        #expect(auth.transferCrcOk)
        #expect(auth.sub == R1.Sub.pairAuth && auth.serial == 1 && auth.data == [1] && auth.status == 0)
        #expect(auth.version == 100 && auth.command == 1 && auth.moduleVersion == 100 && auth.module == 0)
        let adv = try #require(R1.parse(fromHex(captureAdvStart)))
        #expect(adv.transferCrcOk)
        #expect(adv.sub == R1.Sub.advStart && adv.serial == 7)
        #expect(hex(adv.data) == "63a3a7375bd4")
    }

    @Test func buildersMatchCapturesExceptTheUncheckedInnerCrc() throws {
        // The official app's inner CRC-16 does not match workbench's; everything else must.
        func strip(_ f: [UInt8]) -> [UInt8] { Array(f[5..<15]) + Array(f[17...]) }
        #expect(strip(R1.pairAuth(serial: 1)) == strip(fromHex(capturePairAuth)))
        let adv = try R1.advStart(glassesMacRaw: fromHex("63a3a7375bd4"), serial: 7)
        #expect(strip(adv) == strip(fromHex(captureAdvStart)))
        // And our frames are self-consistent.
        for f in [R1.pairAuth(serial: 1), adv, R1.systemTime(serial: 3), R1.deviceStatus(serial: 9)] {
            let d = try #require(R1.parse(f))
            #expect(d.transferCrcOk && d.modelCrcOk)
        }
    }

    @Test func buildersMatchWorkbenchVectors() throws {
        #expect(hex(R1.pairAuth(serial: 1)) == "00f19bde9664016401000000080d00d8b501")
        let mac = fromHex("e49467467387")
        #expect(hex(try R1.advStart(glassesMacRaw: mac, serial: 1)) == "002983e811640164010000000a12001f3ee49467467387")
        let second = try R1.advStart(glassesMacRaw: mac, serial: 2)
        #expect(second[8] == 2)
        #expect(hex(second[0..<5]) == "00c5a8d9a9")
        #expect(hex(second[15..<17]) == "3add")
        #expect(throws: RingError.badMac(count: 3)) { try R1.advStart(glassesMacRaw: [1, 2, 3], serial: 1) }
    }

    @Test func systemTimeLayout() throws {
        let f = try #require(R1.parse(R1.systemTime(serial: 3, now: Date(timeIntervalSince1970: 1000), timeZone: TimeZone(secondsFromGMT: 0)!)))
        #expect(f.sub == R1.Sub.systemTime && f.status == 0x02 && f.isSet && !f.isAck)
        #expect(f.data.count == 12)
        #expect(Array(f.data[0..<6]) == [0, 0, 0xE8, 0x03, 0, 0])
        let west = try #require(R1.parse(R1.systemTime(serial: 4, now: Date(timeIntervalSince1970: 0), timeZone: TimeZone(secondsFromGMT: -5 * 3600)!)))
        #expect(Array(west.data[0..<2]) == [0xD4, 0xFE]) // -300 minutes, i16 LE
    }

    @Test func ackStatusAndBatteryFromHardwareReply() throws {
        // device_status ack captured on hardware (workbench r1_protocol_test.dart): battery 89.
        let f = try #require(R1.parse(fromHex("00cf0dfe726401640300030001130060ad59020100000000")))
        #expect(f.transferCrcOk)
        #expect(f.isAck && f.isSet && f.ackStatus == .ok)
        #expect(R1.battery(from: f) == 89)
        func status(_ s: UInt8) -> R1AckStatus {
            R1.parse(R1.command(sub: R1.Sub.advStart, serial: 1, status: s, data: [1, 2, 3, 4, 5, 6]))!.ackStatus
        }
        #expect(status(0x01) == .ok)
        #expect(status(0x05) == .error)
        #expect(status(0x09) == .refuse)
        #expect(status(0x0D) == .unsupported)
    }

    @Test func damagedOrShortFrames() {
        var f = R1.pairAuth(serial: 1)
        f[f.count - 1] ^= 0xFF
        #expect(R1.parse(f)?.transferCrcOk == false)
        #expect(R1.parse([0xFC]) == nil)
        #expect(R1.parse(Array(R1.pairAuth(serial: 1).prefix(16))) == nil)
    }

    // MARK: direct phone -> ring handoff (fallback)

    @Test func g2MacRawIsStrippedBytes14To19NotReversed() {
        let data = Array("S200LBBP123456".utf8) + [0x63, 0xA3, 0xA7, 0x37, 0x5B, 0xD4]
        #expect(g2MacRaw(fromManufacturer: data) == [0x63, 0xA3, 0xA7, 0x37, 0x5B, 0xD4])
        #expect(parseG2Manufacturer(data).mac == "D4:5B:37:A7:A3:63")
        #expect(g2MacRaw(fromManufacturer: Array(data.prefix(19))) == nil)
        #expect(g2MacRaw(fromManufacturer: nil) == nil)
    }

    @Test func lensMacMustMatchTheLensNameBeforeAHandoff() {
        // Real left arm: "Even G2_32_L_A1B2C3" advertises 02:00:00:A1:B2:C3.
        let left = Array("S000TEST000001".utf8) + [0xC3, 0xB2, 0xA1, 0x00, 0x00, 0x02]
        let raw = g2MacRaw(fromManufacturer: left)!
        #expect(parseG2Manufacturer(left).mac == "02:00:00:A1:B2:C3")
        #expect(g2MacMatchesName(raw, name: "Even G2_32_L_A1B2C3") == true)
        #expect(g2MacMatchesName(raw, name: "even g2_32_l_A1B2C3") == true)
        #expect(g2MacMatchesName(raw, name: "Even G2_32_R_D4E5F6") == false)
        #expect(g2MacMatchesName(Array(raw.reversed()), name: "Even G2_32_L_A1B2C3") == false)
        #expect(g2MacMatchesName(raw, name: "Even G2") == nil)
        #expect(g2MacMatchesName(raw, name: "Even G2_32_L_63064") == nil)
        #expect(g2MacMatchesName(raw, name: nil) == nil)
        #expect(g2MacMatchesName([1, 2, 3], name: "Even G2_32_L_A1B2C3") == nil)
    }

    @MainActor
    func ring() -> MockPeripheral {
        let r = MockPeripheral("RING", "EVEN R1_CEC5BA")
        r.characteristics = [R1UUID.notify1, R1UUID.write2, R1UUID.notify2]
        return r
    }

    @MainActor
    @Test func handoffSendsPairAuthSystemTimeAdvStartAndReadsAcks() async throws {
        let r = ring()
        let mac: [UInt8] = [0x63, 0xA3, 0xA7, 0x37, 0x5B, 0xD4]
        r.onWrite = { [weak r] _, data in
            guard let r, let f = R1.parse(data) else { return }
            // pair_auth is acked at once (before the wait starts); adv_start is refused a moment later.
            let ack = R1.command(sub: f.sub, serial: f.serial, status: f.sub == R1.Sub.advStart ? 0x09 : 0x01)
            if f.sub == R1.Sub.pairAuth { r.notify(R1UUID.notify2, ack) }
            if f.sub == R1.Sub.advStart { Task { @MainActor in await tick(5); r.notify(R1UUID.notify1, ack) } }
        }
        var lines: [String] = []
        let result = try await R1Handoff.run(ring: r, glassesMacRaw: mac, settleMs: 0, stepMs: 0, pairAuthTimeoutMs: 500,
                                             advStartTimeoutMs: 500, log: { lines.append($0) })
        #expect(result == R1HandoffResult(pairAuth: .ack(.ok), advStart: .ack(.refuse)))
        #expect(!result.accepted)
        let frames = r.writes.compactMap { R1.parse($0.data) }
        #expect(r.writes.allSatisfy { $0.characteristic == R1UUID.write2 && $0.withoutResponse })
        #expect(frames.map(\.sub) == [R1.Sub.pairAuth, R1.Sub.systemTime, R1.Sub.advStart])
        #expect(frames.map(\.serial) == [1, 2, 3])
        #expect(frames[2].data == mac)
        #expect(lines.contains("ring: pair_auth ack ok"))
        #expect(lines.contains("ring: adv_start(R 63:A3:A7:37:5B:D4) ack refuse"))
        // Both notify characteristics were subscribed and released afterwards.
        #expect(Set(r.unsubscribeCalls) == [R1UUID.notify1, R1UUID.notify2])
    }

    @MainActor
    @Test func handoffTimesOutWithoutAcks() async throws {
        let r = ring()
        r.characteristics.remove(R1UUID.notify1)
        var lines: [String] = []
        let result = try await R1Handoff.run(ring: r, glassesMacRaw: [1, 2, 3, 4, 5, 6], settleMs: 0, stepMs: 0, pairAuthTimeoutMs: 20,
                                             advStartTimeoutMs: 20, log: { lines.append($0) })
        #expect(result == R1HandoffResult(pairAuth: .timeout, advStart: .timeout))
        #expect(lines.contains("ring: adv_start(R 01:02:03:04:05:06) ack timeout"))
        #expect(r.unsubscribeCalls == [R1UUID.notify2])
    }

    @MainActor
    @Test func handoffRefusesBadInput() async {
        let r = ring()
        await #expect(throws: RingError.badMac(count: 5)) {
            _ = try await R1Handoff.run(ring: r, glassesMacRaw: [1, 2, 3, 4, 5], settleMs: 0)
        }
        r.characteristics = [R1UUID.write2]
        await #expect(throws: RingError.noNotifyCharacteristic("EVEN R1_CEC5BA")) {
            _ = try await R1Handoff.run(ring: r, glassesMacRaw: [1, 2, 3, 4, 5, 6], settleMs: 0)
        }
        #expect(r.writes.isEmpty)
    }

    @Test func ringDiscoveryOnlyRequiresTheCommandWrite() {
        var g = GattCatalog<String>(required: GattCatalog<String>.ringRequired)
        g.begin(services: [R1UUID.service, "180F"])
        g.add(service: "180F", found: [.init(uuid: "2A19", properties: "r+ntf", value: "battery")])
        #expect(g.missing == [R1UUID.write2])
        let done = g.add(service: R1UUID.service, found: [.init(uuid: R1UUID.write2.lowercased(), properties: "wnr", value: "w2"),
                                                          .init(uuid: R1UUID.notify2, properties: "ntf", value: "n2")])
        #expect(done && g.missing.isEmpty && g.value(R1UUID.write2) == "w2")
        #expect(g.summary == ["180F[2A19 r+ntf]", "BAE80001[BAE80012 wnr,BAE80013 ntf]"])
        // A lens catalog still requires 5401/5402.
        #expect(GattCatalog<String>().missing == [G2UUID.write, G2UUID.notify])
    }
}
