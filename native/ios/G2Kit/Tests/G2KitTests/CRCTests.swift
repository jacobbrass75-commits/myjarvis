// Port of native/driver/test/crc.test.ts.
import Testing
@testable import G2Kit

@Suite struct CRCTests {
    @Test func checkValue() {
        #expect(crc16(Array("123456789".utf8)) == 0x29B1)
        #expect(crc16([UInt8]()) == 0xFFFF)
    }

    @Test func mentraFormulationIsTheSameCRC() {
        var seed = 7
        for n in 0..<200 {
            let data: [UInt8] = (0..<n).map { _ in
                seed = (seed &* 1103515245 &+ 12345) & 0xFF
                return UInt8(seed)
            }
            #expect(crc16Mentra(data) == crc16(data), "len \(n)")
        }
    }

    // Real packet captured from the official Even App (btsnoop), published in g2-kit-unofficial
    // ble/messages.ts as PRELUDE_F5872: sid 0x01 (dashboard) Cmd 2, sync id 0x92, flag 0x20.
    static let captured = "aa21921301010120" + "0802109c01220a1a0812061204080010" + "00" + "a142"

    @Test func capturedEvenAppPacketRoundTrips() throws {
        let raw = fromHex(Self.captured)
        let p = try #require(parsePacket(raw))
        #expect(p.service == 0x01)
        #expect(p.syncId == 0x92)
        #expect(p.total == 1)
        #expect(p.crc == 0x42A1)
        #expect(crc16(p.chunk) == p.crc)
        let rebuilt = try buildPackets(p.chunk, syncId: 0x92, service: 0x01, flag: 0x20)
        #expect(rebuilt.count == 1)
        #expect(hex(rebuilt[0]) == Self.captured)
    }
}
