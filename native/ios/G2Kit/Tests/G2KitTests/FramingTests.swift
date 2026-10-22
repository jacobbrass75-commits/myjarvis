// Port of native/driver/test/framing.test.ts.
import Foundation
import Testing
@testable import G2Kit

@Suite struct FramingTests {
    private func withCrc(_ header: String, _ payload: String) -> String {
        let c = crc16(fromHex(payload))
        return header + payload + hex([UInt8(c & 0xFF), UInt8(c >> 8)])
    }

    // i-soxi/even-g2-protocol teleprompter.py hard-codes the first handshake packets the Even App sends.
    @Test func authPacketMatchesCapture() throws {
        let pkt = try buildPackets(DevConfig.auth(magic: 0x0C), syncId: 0x01, service: 0x80)[0]
        #expect(hex(pkt) == withCrc("aa21010c01018000", "0804100c1a0408011004"))
    }

    @Test func pipeRoleChangeMatchesCapture() throws {
        let pkt = try buildPackets(DevConfig.pipeRoleChange(magic: 0x0E, role: 2), syncId: 0x02, service: 0x80, flag: 0x20)[0]
        #expect(hex(pkt) == withCrc("aa21020a01018020", "0805100e22020802"))
    }

    @Test func timeSyncUsesField128() {
        let p = DevConfig.timeSync(magic: 0x0F, now: Date(timeIntervalSince1970: 0), timeZone: TimeZone(secondsFromGMT: 0)!)
        #expect(hex(p[0..<6]) == "088001100f82")
        #expect(p[6] == 0x08)
    }

    @Test func negativeInt32IsTenByteVarint() {
        #expect(hex(PbWriter().varint(-24).finish()) == "e8ffffffffffffffff01")
        #expect(hex(PbWriter().varint(300).finish()) == "ac02")
    }

    @Test func singlePacketLengthAndFlag() throws {
        let a = try buildPackets([1, 2, 3], syncId: 5, service: 0xE0)[0]
        #expect(Array(a[0..<8]) == [0xAA, 0x21, 5, 5, 1, 1, 0xE0, 0x20])
        let b = try buildPackets([1], syncId: 5, service: 0x80)[0]
        #expect(b[7] == 0x00)
    }

    @Test func emptyPayloadCarriesCRC() throws {
        let ps = try buildPackets([], syncId: 1, service: 0xE0)
        #expect(ps.count == 1)
        #expect(ps[0][3] == 2)
        #expect(hex(ps[0][8...]) == "ffff")
    }

    @Test func multiPacket() throws {
        let payload = (0..<600).map { UInt8($0 & 0xFF) }
        let ps = try buildPackets(payload, syncId: 0x33, service: 0xE0)
        #expect(ps.count == 3)
        #expect(ps.map { $0[2] } == [0x33, 0x33, 0x33])
        #expect(ps.map { $0[4] } == [3, 3, 3])
        #expect(ps.map { $0[5] } == [1, 2, 3])
        #expect(ps.map { $0[3] } == [236, 236, 128 + 2])
        let last = ps[2]
        #expect(UInt16(last[last.count - 2]) | UInt16(last[last.count - 1]) << 8 == crc16(payload))
    }

    @Test func fullLastChunkGetsCRCOnlyPacket() throws {
        let ps = try buildPackets([UInt8](repeating: 0, count: 236), syncId: 1, service: 0xE0)
        #expect(ps.count == 2)
        #expect(ps[0][3] == 236)
        #expect(ps[1][3] == 2)
        #expect(ps[1].count == 10)
    }

    @Test func reassemblerRoundTrip() throws {
        let payload = (0..<1000).map { UInt8(($0 * 7) & 0xFF) }
        let r = Reassembler()
        let pk = rxPackets(0xE0, payload, syncId: 9)
        for p in pk.dropLast() { #expect(r.push(p, source: "R") == nil) }
        let m = try #require(r.push(pk.last!, source: "R"))
        #expect(m.payload == payload)
        #expect(m.crcOk == true)
        #expect(m.service == 0xE0)
    }

    @Test func reassemblerKeepsLensesApart() throws {
        let a = rxPackets(0xE0, [UInt8](repeating: 0xAA, count: 300), syncId: 7)
        let b = rxPackets(0xE0, [UInt8](repeating: 0xBB, count: 300), syncId: 7)
        let r = Reassembler()
        _ = r.push(a[0], source: "L")
        _ = r.push(b[0], source: "R")
        let ma = try #require(r.push(a[1], source: "L"))
        let mb = try #require(r.push(b[1], source: "R"))
        #expect(ma.payload.allSatisfy { $0 == 0xAA })
        #expect(mb.payload.allSatisfy { $0 == 0xBB })
    }

    @Test func nonZeroResultCodeDropsMessage() {
        let r = Reassembler()
        let p = rxPackets(0xE0, [8, 1], syncId: 1, status: 0x02)[0]
        #expect(parsePacket(p)?.resultCode == 1)
        #expect(r.push(p) == nil)
        #expect(r.rejected == 1)
    }

    @Test func outOfOrderFragmentResets() {
        let pk = rxPackets(0xE0, [UInt8](repeating: 0, count: 600), syncId: 3)
        let r = Reassembler()
        _ = r.push(pk[0])
        #expect(r.push(pk[2]) == nil)
        #expect(r.push(pk[1]) == nil)
    }

    @Test func garbageIgnored() {
        let r = Reassembler()
        #expect(r.push([1, 2, 3]) == nil)
        #expect(r.push(fromHex("aa1201ff01010e00")) == nil) // claims 255 bytes, has none
    }

    @Test func counter8Wraps() {
        let c = Counter8(254)
        #expect([c.next(), c.next(), c.next()] == [254, 255, 0])
    }
}
