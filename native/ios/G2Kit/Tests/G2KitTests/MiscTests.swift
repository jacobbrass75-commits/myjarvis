// Port of native/driver/test/misc.test.ts and lc3.test.ts.
import Foundation
import Testing
@testable import G2Kit

@Suite struct MiscTests {
    private func u32(_ b: [UInt8], _ o: Int) -> UInt32 { UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24 }

    @Test func fourBitBmpLayout() {
        // 4x2 image: top row 0,17,34,51 -> indices 0,1,2,3 ; bottom row 255,238,221,204 -> 15,14,13,12
        let bmp = build4BitBmp(GrayImage(width: 4, height: 2, pixels: [0, 17, 34, 51, 255, 238, 221, 204]))
        #expect(bmp[0] == 0x42 && bmp[1] == 0x4D)
        #expect(u32(bmp, 2) == UInt32(bmp.count))
        #expect(u32(bmp, 10) == 118)
        #expect(UInt16(bmp[28]) | UInt16(bmp[29]) << 8 == 4)
        #expect(u32(bmp, 46) == 16)
        #expect(Array(bmp[(54 + 15 * 4)..<(54 + 16 * 4)]) == [255, 255, 255, 0])
        #expect(bmp.count == 118 + 2 * 4)
        #expect(Array(bmp[118..<122]) == [0xFE, 0xDC, 0, 0]) // first stored row = bottom
        #expect(Array(bmp[122..<126]) == [0x01, 0x23, 0, 0])
    }

    /// The same bytes as the glasses page's encodeGray4Bmp (scripts/image-path-test.mjs), which the
    /// iPhone app passes through untouched: levels [0,1,2 / 15,8,0], odd width.
    @Test func fourBitBmpMatchesThePageEncoder() {
        let bmp = build4BitBmp(GrayImage(width: 3, height: 2, pixels: [0, 17, 34, 255, 136, 0]))
        #expect(hex(bmp) == "424d7e0000000000000076000000280000000300000002000000010004000000000008000000130b0000130b00001000000000000000"
            + "00000000111111002222220033333300444444005555550066666600777777008888880099999900aaaaaa00bbbbbb00cccccc00dddddd00eeeeee00ffffff00"
            + "f800000001200000")
    }

    @Test func fullTileFitsInSixFragments() {
        let bmp = build4BitBmp(.solid(width: 288, height: 144, level: 255))
        #expect(bmp.count == 118 + 144 * 144)
        #expect((bmp.count + 4095) / 4096 == 6)
    }

    @Test func audioSplitTrailerRunts() {
        let pkt = (0..<205).map { UInt8($0) }
        let frames = splitAudioPacket(pkt)
        #expect(frames.count == 5)
        #expect(frames[4][0] == 160)
        #expect(audioTrailer(pkt) == [200, 201, 202, 203, 204])
        #expect(splitAudioPacket([UInt8](repeating: 0, count: 30)).isEmpty)
    }

    @Test func audioDedupe() {
        let d = AudioDeduper()
        let a = [UInt8](repeating: 1, count: 200)
        #expect(d.accept(a))
        #expect(!d.accept(a))
        #expect(d.accept([UInt8](repeating: 2, count: 200)))
    }

    @Test func pcmIsS16LE() {
        #expect(hex(pcmToBytes([1, -2])) == "0100feff")
    }

    @Test func r1Notifications() {
        #expect(parseRingNotification([0xFF, 0x04, 0x01]) == .gesture(.tap))
        #expect(parseRingNotification([0xFF, 0x04, 0x02]) == .gesture(.doubleTap))
        #expect(parseRingNotification([0xFF, 0x03, 0x00]) == .gesture(.hold))
        #expect(parseRingNotification([0xFF, 0x05, 0x10]) == .gesture(.swipeUp))
        #expect(parseRingNotification([0xFF, 0x05, 0xF0]) == .gesture(.swipeDown))
        #expect(parseRingNotification([1, 2, 0xFF, 0x04, 0x01, 9]) == .gesture(.tap))
        #expect(parseRingNotification([76, 0]) == .battery(76))
        #expect(parseRingNotification([1]) == .state(ready: true, raw: 1))
    }

    @Test func r1AdvStartAndRingBinding() throws {
        let mac = try #require(parseMac("1B:08:26:8E:0E:E6"))
        #expect(formatMac(mac) == "1B:08:26:8E:0E:E6")
        #expect(hex(R1.advStart(glassesLeftMac: mac)) == "0000091b08268e0ee6")
        let m = PbMessage(DevConfig.ringConnectInfo(magic: 3, connect: true, ringMac: mac, ringName: "EVEN R1_CEC5BA"))
        #expect(m.int(1) == 6)
        let r = try #require(m.message(5))
        #expect(r.int(1) == 1)
        #expect(hex(r.bytes(2)!) == "1b08268e0ee6")
        #expect(r.string(3) == "EVEN R1_CEC5BA")
        #expect(R1.ringId(fromName: "EVEN R1_CEC5BA") == "CEC5BA")
    }

    @Test func g2Advertisement() {
        #expect(sideFromName("Even G2_32_L_1A2B3C") == .left)
        #expect(sideFromName("Even G2_32_R_1A2B3C") == .right)
        #expect(sideFromName("Even G1_32_L_1A2B3C") == nil)
        var md = [UInt8](repeating: 0, count: 20)
        md.replaceSubrange(0..<14, with: Array("S110LABC123456".utf8))
        md.replaceSubrange(14..<20, with: [0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
        let parsed = parseG2Manufacturer(md)
        #expect(parsed.serial == "S110LABC123456")
        #expect(parsed.mac == "11:22:33:44:55:66")
    }

    @Test func pairFinderMatchesBySerial() {
        var md = Array("S110LABC123456".utf8) + [1, 2, 3, 4, 5, 6]
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "a", name: "Even G2_32_L_ABC", manufacturerData: md)) == nil)
        #expect(f.add(Advertisement(id: "x", name: "Even G2_32_R_ZZZ", manufacturerData: Array("OTHERSERIAL123".utf8))) == nil)
        md[19] = 9
        let pair = f.add(Advertisement(id: "b", name: "Even G2_32_R_ABC", manufacturerData: md))
        #expect(pair?.serial == "S110LABC123456")
        #expect(pair?.left.advert.id == "a")
        #expect(pair?.right.advert.id == "b")
        #expect(pair?.right.mac == "09:05:04:03:02:01")
    }

    @Test func pairFinderRecoversMixedMetadataInEitherOrderAndSide() {
        let md = Array("S110LABC123456".utf8) + [1, 2, 3, 4, 5, 6]
        for sparseSide in Side.allCases {
            for richFirst in [false, true] {
                var f = PairFinder()
                let left = Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: sparseSide == .left ? nil : md)
                let right = Advertisement(id: "right", name: "Even G2_32_R_ABC", manufacturerData: sparseSide == .right ? nil : md)
                let rich = sparseSide == .left ? right : left
                let sparse = sparseSide == .left ? left : right
                #expect(f.add(richFirst ? rich : sparse) == nil)
                let pair = f.add(richFirst ? sparse : rich)
                #expect(pair?.serial == "S110LABC123456")
                #expect(pair?.left.advert.id == "left")
                #expect(pair?.right.advert.id == "right")
            }
        }
    }

    @Test func pairFinderSparseSightingsRetainIdentityAndRemoveStaleBuckets() {
        let md = Array("S110LABC123456".utf8) + [1, 2, 3, 4, 5, 6]
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC")) == nil)
        #expect(f.seen["ABC"]?[.left]?.advert.id == "left")
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", rssi: -50, manufacturerData: md)) == nil)
        #expect(f.seen["ABC"] == nil)
        for sparse in [nil, [], [1, 2, 3], Array("S110LABC123456".utf8)] as [[UInt8]?] {
            #expect(f.add(Advertisement(id: "left", name: "", manufacturerData: sparse)) == nil)
        }
        #expect(f.seen.count == 1)
        #expect(f.seen["S110LABC123456"]?[.left]?.mac == "06:05:04:03:02:01")
        #expect(f.seen["S110LABC123456"]?[.left]?.advert.rssi == -50)
        // Real arm names can differ; a shared serial remains authoritative over their suffixes.
        let pair = f.add(Advertisement(id: "right", name: "Even G2_32_R_OTHER", manufacturerData: md))
        #expect(pair?.left.advert.manufacturerData == md)
        #expect(pair?.left.advert.name == "Even G2_32_L_ABC")
        #expect(pair?.right.advert.id == "right")
    }

    @Test func pairFinderRejectsConflictingSerialsEvenWithMatchingNames() {
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: Array("S110LABC123456".utf8))) == nil)
        #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_ABC", manufacturerData: Array("S200LACA040040".utf8))) == nil)
        #expect(f.pairRequiringConfirmation == nil)
    }

    @Test func pairFinderLeavesAmbiguousSparseCandidatesUnpaired() {
        for sparseSide in Side.allCases {
            var f = PairFinder()
            let marker = sparseSide == .left ? "R" : "L"
            #expect(f.add(Advertisement(id: "one", name: "Even G2_32_\(marker)_ABC", manufacturerData: Array("S110LABC123456".utf8))) == nil)
            #expect(f.add(Advertisement(id: "two", name: "Even G2_32_\(marker)_ABC", manufacturerData: Array("S200LACA040040".utf8))) == nil)
            let sparseMarker = sparseSide == .left ? "L" : "R"
            #expect(f.add(Advertisement(id: "sparse", name: "Even G2_32_\(sparseMarker)_ABC")) == nil)
            #expect(f.pairRequiringConfirmation == nil)
        }
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left-one", name: "Even G2_32_L_ABC")) == nil)
        #expect(f.add(Advertisement(id: "left-two", name: "Even G2_32_L_ABC")) == nil)
        #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_ABC")) == nil)
        #expect(f.pairRequiringConfirmation == nil)
    }

    @Test func pairFinderOffersDifferentSuffixesOnlyForExplicitConfirmation() {
        let md = Array("S110LABC123456".utf8) + [1, 2, 3, 4, 5, 6]
        for sparseSide in Side.allCases {
            for richFirst in [false, true] {
                var f = PairFinder()
                let left = Advertisement(id: "left", name: "Even G2_32_L_A1B2C3", manufacturerData: sparseSide == .left ? nil : md)
                let right = Advertisement(id: "right", name: "Even G2_32_R_123ABC", manufacturerData: sparseSide == .right ? nil : md)
                let rich = sparseSide == .left ? right : left
                let sparse = sparseSide == .left ? left : right
                #expect(f.add(richFirst ? rich : sparse) == nil)
                #expect(f.pairRequiringConfirmation == nil)
                #expect(f.add(richFirst ? sparse : rich) == nil)
                #expect(f.pairRequiringConfirmation?.serial == "S110LABC123456")
                #expect(f.pairRequiringConfirmation?.left.advert.id == "left")
                #expect(f.pairRequiringConfirmation?.right.advert.id == "right")
                // Repeated sightings of one UUID do not create another confirmation choice.
                #expect(f.add(sparse) == nil)
                #expect(f.pairRequiringConfirmation?.serial == "S110LABC123456")
            }
        }
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_A1B2C3")) == nil)
        #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_123ABC")) == nil)
        #expect(f.pairRequiringConfirmation?.serial == "")
    }

    @Test func pairFinderConfirmationRejectsKnownSerialOutsideFilterAndDuplicateUUID() {
        var filtered = PairFinder(serialFilter: "S200")
        #expect(filtered.add(Advertisement(id: "left", name: "Even G2_32_L_A1B2C3", manufacturerData: Array("S110LABC123456".utf8))) == nil)
        #expect(filtered.add(Advertisement(id: "right", name: "Even G2_32_R_123ABC")) == nil)
        #expect(filtered.pairRequiringConfirmation == nil)
        var sameID = PairFinder()
        #expect(sameID.add(Advertisement(id: "one", name: "Even G2_32_L_A1B2C3")) == nil)
        #expect(sameID.add(Advertisement(id: "one", name: "Even G2_32_R_123ABC")) == nil)
        #expect(sameID.pairRequiringConfirmation == nil)
    }

    @Test func pairFinderPrefersExactSerialOverWeakerSuffixMatch() {
        let md = Array("S110LABC123456".utf8)
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "sparse-right", name: "Even G2_32_R_ABC")) == nil)
        #expect(f.add(Advertisement(id: "serial-right", name: "Even G2_32_R_OTHER", manufacturerData: md)) == nil)
        let pair = f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: md))
        #expect(pair?.right.advert.id == "serial-right")
    }

    @Test func pairFinderDoesNotInferIdentityFromSideOrModelAlone() {
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC")) == nil)
        #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_OTHER")) == nil)
        var empty = PairFinder()
        #expect(empty.add(Advertisement(id: "left", name: "Even G2_32_L_")) == nil)
        #expect(empty.add(Advertisement(id: "right", name: "Even G2_32_R_")) == nil)
    }

    @Test func pairFinderStoresEachUUIDOnlyOnceAfterIdentityChanges() {
        let a = Array("S110LABC123456".utf8), b = Array("S200LACA040040".utf8)
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: a)) == nil)
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: b)) == nil)
        #expect(f.seen["S110LABC123456"] == nil)
        #expect(f.seen.count == 1)
        #expect(f.add(Advertisement(id: "old-right", name: "Even G2_32_R_ABC", manufacturerData: a)) == nil)
        #expect(f.add(Advertisement(id: "new-right", name: "Even G2_32_R_OTHER", manufacturerData: b))?.serial == "S200LACA040040")
        var sameID = PairFinder()
        #expect(sameID.add(Advertisement(id: "one", name: "Even G2_32_L_ABC")) == nil)
        #expect(sameID.add(Advertisement(id: "one", name: "Even G2_32_R_ABC")) == nil)
        #expect(sameID.seen["ABC"]?[.left] == nil)
        #expect(sameID.seen["ABC"]?[.right]?.advert.id == "one")
    }

    @Test func pairFinderKeepsUnrelatedPairsSeparateAndAppliesSerialFilter() {
        let a = Array("S110LABC123456".utf8), b = Array("S200LACA040040".utf8)
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left-a", name: "Even G2_32_L_ABC", manufacturerData: a)) == nil)
        #expect(f.add(Advertisement(id: "left-b", name: "Even G2_32_L_DEF", manufacturerData: b)) == nil)
        #expect(f.add(Advertisement(id: "right-b", name: "Even G2_32_R_OTHER", manufacturerData: b))?.left.advert.id == "left-b")
        #expect(f.add(Advertisement(id: "right-a", name: "Even G2_32_R_OTHER", manufacturerData: a))?.left.advert.id == "left-a")
        var filtered = PairFinder(serialFilter: "s110")
        #expect(filtered.add(Advertisement(id: "right", name: "Even G2_32_R_ABC")) == nil)
        #expect(filtered.add(Advertisement(id: "left", name: "Even G2_32_L_ABC", manufacturerData: a))?.serial == "S110LABC123456")
    }

    // MARK: system-held arms (no advertisement, so usually no serial)

    @Test func pairFinderAutoPairsWhenBothOnlyArmsAreSystemHeld() {
        for leftFirst in [true, false] {
            var f = PairFinder()
            let left = Advertisement(id: "left-uuid", name: "Even G2_32_L_A1B2C3", source: .systemConnected)
            let right = Advertisement(id: "right-uuid", name: "Even G2_32_R_123ABC", source: .systemConnected)
            #expect(f.add(leftFirst ? left : right) == nil)
            #expect(f.lastDecision?.hasSuffix(leftFirst ? "none(no right arm yet)" : "none(no left arm yet)") == true)
            let pair = f.add(leftFirst ? right : left)
            #expect(pair?.left.advert.id == "left-uuid")
            #expect(pair?.right.advert.id == "right-uuid")
            #expect(pair?.left.advert.source == .systemConnected)
            #expect(f.lastDecision == "pair: L=left-uui src=system serial=none · R=right-uu src=system serial=none → auto(both system-held)")
        }
        // A persisted serial on one held arm does not conflict with a held arm that has none.
        var f = PairFinder()
        let md = Array("S200LACA040040".utf8) + [6, 5, 4, 3, 2, 1]
        #expect(f.add(Advertisement(id: "l", name: "Even G2_32_L_A1B2C3", manufacturerData: md, source: .systemConnected)) == nil)
        let pair = f.add(Advertisement(id: "r", name: "Even G2_32_R_123ABC", source: .systemConnected))
        #expect(pair?.serial == "S200LACA040040")
        #expect(pair?.left.mac == "01:02:03:04:05:06")
    }

    @Test func pairFinderMixedHeldAndAdvertisingStillNeedsConfirmation() {
        for heldSide in Side.allCases {
            var f = PairFinder()
            #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_A1B2C3", source: heldSide == .left ? .systemConnected : .advert)) == nil)
            #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_123ABC", source: heldSide == .right ? .systemConnected : .advert)) == nil)
            #expect(f.pairRequiringConfirmation?.left.advert.id == "left")
            #expect(f.lastDecision?.hasSuffix("→ confirm(mixed)") == true)
        }
        // Two advertising arms with different suffixes and no serial: confirmation, not "mixed".
        var f = PairFinder()
        #expect(f.add(Advertisement(id: "left", name: "Even G2_32_L_A1B2C3")) == nil)
        #expect(f.add(Advertisement(id: "right", name: "Even G2_32_R_123ABC")) == nil)
        #expect(f.lastDecision?.hasSuffix("→ confirm(no shared serial)") == true)
    }

    @Test func pairFinderSystemHeldRuleRefusesConflictsAndCrowds() {
        var conflict = PairFinder()
        #expect(conflict.add(Advertisement(id: "l", name: "Even G2_32_L_A", manufacturerData: Array("S110LABC123456".utf8), source: .systemConnected)) == nil)
        #expect(conflict.add(Advertisement(id: "r", name: "Even G2_32_R_B", manufacturerData: Array("S200LACA040040".utf8), source: .systemConnected)) == nil)
        #expect(conflict.lastDecision?.hasSuffix("→ none(serials differ)") == true)
        var crowd = PairFinder()
        #expect(crowd.add(Advertisement(id: "l1", name: "Even G2_32_L_A", source: .systemConnected)) == nil)
        #expect(crowd.add(Advertisement(id: "l2", name: "Even G2_32_L_B", source: .systemConnected)) == nil)
        #expect(crowd.add(Advertisement(id: "r", name: "Even G2_32_R_C", source: .systemConnected)) == nil)
        #expect(crowd.lastDecision?.hasSuffix("→ none(ambiguous: 2 left, 1 right)") == true)
        // An arm that starts advertising is no longer held: the latest sighting sets the source.
        var moved = PairFinder()
        #expect(moved.add(Advertisement(id: "l", name: "Even G2_32_L_A", source: .systemConnected)) == nil)
        #expect(moved.add(Advertisement(id: "l", name: "Even G2_32_L_A", source: .advert)) == nil)
        #expect(moved.add(Advertisement(id: "r", name: "Even G2_32_R_B", source: .systemConnected)) == nil)
        #expect(moved.lastDecision?.hasSuffix("→ confirm(mixed)") == true)
        // Serial matches are still reported as such.
        var serial = PairFinder()
        let md = Array("S110LABC123456".utf8)
        #expect(serial.add(Advertisement(id: "l", name: "Even G2_32_L_A", manufacturerData: md)) == nil)
        #expect(serial.add(Advertisement(id: "r", name: "Even G2_32_R_B", manufacturerData: md, source: .systemConnected)) != nil)
        #expect(serial.lastDecision?.hasSuffix("→ auto(serial)") == true)
    }

    @Test func identityStorePersistsOnlySerialBearingData() throws {
        let suite = "g2kit.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let id = "1a2b3c4d-0000-0000-0000-000000000000"
        let md = Array("S200LACA040040".utf8) + [0x66, 0x55, 0x44, 0x33, 0x22, 0x11]
        #expect(G2IdentityStore.key(id) == "g2.mfr.1A2B3C4D-0000-0000-0000-000000000000")
        #expect(!G2IdentityStore.save([1, 2, 3], for: id, defaults: defaults))
        #expect(!G2IdentityStore.save(nil, for: id, defaults: defaults))
        #expect(G2IdentityStore.load(id, defaults: defaults) == nil)
        #expect(G2IdentityStore.save(md, for: id, defaults: defaults))
        #expect(!G2IdentityStore.save(md, for: id, defaults: defaults))
        #expect(G2IdentityStore.load(id.uppercased(), defaults: defaults) == md)
        #expect(defaults.string(forKey: G2IdentityStore.key(id)) == hex(md))
        defaults.set("zz1", forKey: G2IdentityStore.key(id))
        #expect(G2IdentityStore.load(id, defaults: defaults) == nil)
    }

    // MARK: GATT discovery across services

    /// Current firmware: 5401/5402 under 5450, 6401/6402 under 6450, file service 7450, nothing
    /// under the advertised …0000.
    static let currentLayout: [(service: String, chars: [(String, String)])] = [
        ("1801", [("2A05", "ind")]),
        (G2UUID.controlService, [(G2UUID.write, "wnr"), (G2UUID.notify, "ntf")]),
        (G2UUID.audioService, [(G2UUID.base("6401"), "w"), (G2UUID.audioNotify, "ntf")]),
        (G2UUID.fileService, [(G2UUID.fileWrite, "wnr"), (G2UUID.fileNotify, "ntf")]),
        ("6E400001-B5A3-F393-E0A9-E50E24DCCA9E", [("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", "wnr")]),
    ]

    func discover(_ layout: [(service: String, chars: [(String, String)])], failing: Set<String> = []) -> GattCatalog<String> {
        var g = GattCatalog<String>()
        g.begin(services: layout.map(\.service))
        for (i, s) in layout.enumerated() {
            #expect(!g.isComplete)
            let found = s.chars.map { GattCatalog<String>.Found(uuid: $0.0.lowercased(), properties: $0.1, value: "\(s.service)/\($0.0)") }
            let done = g.add(service: s.service, found: failing.contains(s.service) ? [] : found, error: failing.contains(s.service) ? "busy" : nil)
            #expect(done == (i == layout.count - 1))
        }
        return g
    }

    @Test func gattMergesCharacteristicsAcrossServices() {
        let g = discover(Self.currentLayout)
        #expect(g.isComplete)
        #expect(g.missing.isEmpty)
        for c in [G2UUID.write, G2UUID.notify, G2UUID.audioNotify, G2UUID.fileNotify] {
            #expect(g.has(c) && g.has(c.lowercased()))
        }
        #expect(g.value(G2UUID.write) == "\(G2UUID.controlService)/\(G2UUID.write)")
        #expect(g.value(G2UUID.audioNotify) == "\(G2UUID.audioService)/\(G2UUID.audioNotify)")
        #expect(g.summary.joined(separator: " ") ==
            "1801[2A05 ind] …5450[5401 wnr,5402 ntf] …6450[6401 w,6402 ntf] …7450[7401 wnr,7402 ntf] 6E400001[6E400002 wnr]")
    }

    @Test func gattOnlyRequiresControlCharacteristics() {
        // A failing or audio-less service is not fatal...
        let noAudio = discover(Self.currentLayout, failing: [G2UUID.audioService])
        #expect(noAudio.missing.isEmpty)
        #expect(!noAudio.has(G2UUID.audioNotify))
        #expect(noAudio.summary.contains("…6450[error: busy]"))
        // ...but 5401/5402 are.
        let noControl = discover(Self.currentLayout, failing: [G2UUID.controlService])
        #expect(noControl.missing == [G2UUID.write, G2UUID.notify])
        // The old single-service layout under …0000 still works.
        let legacy = discover([(G2UUID.advertisedService, [(G2UUID.write, "wnr"), (G2UUID.notify, "ntf"), (G2UUID.audioNotify, "ntf")])])
        #expect(legacy.missing.isEmpty && legacy.has(G2UUID.audioNotify))
        #expect(legacy.summary == ["…0000[5401 wnr,5402 ntf,6402 ntf]"])
    }

    @Test func gattPrefersExpectedServiceAndDropsInvalidatedOnes() {
        var layout = Self.currentLayout
        layout.insert((G2UUID.advertisedService, [(G2UUID.write, "w")]), at: 0)
        layout.append(("ABCD", [(G2UUID.notify, "ntf")]))
        var g = discover(layout)
        #expect(g.value(G2UUID.write) == "\(G2UUID.controlService)/\(G2UUID.write)")
        #expect(g.value(G2UUID.notify) == "\(G2UUID.controlService)/\(G2UUID.notify)")
        let audioGone = g.invalidate(services: [G2UUID.audioService.lowercased()])
        #expect(audioGone == [G2UUID.base("6401"), G2UUID.audioNotify])
        #expect(!g.has(G2UUID.audioNotify) && g.missing.isEmpty)
        let controlGone = g.invalidate(services: [G2UUID.controlService])
        #expect(controlGone == [G2UUID.write, G2UUID.notify])
        #expect(g.missing == [G2UUID.write, G2UUID.notify])
        // Duplicate service UUIDs each have to report before the round completes.
        var dup = GattCatalog<String>()
        dup.begin(services: ["180A", "180A"])
        let first = dup.add(service: "180A", found: [])
        let second = dup.add(service: "180A", found: [])
        #expect(!first && second)
    }

    @Test func gattLabels() {
        #expect(GattCatalog<String>.short(G2UUID.controlService, service: true) == "…5450")
        #expect(GattCatalog<String>.short(G2UUID.write.lowercased()) == "5401")
        #expect(GattCatalog<String>.short(R1UUID.service) == "BAE80001")
        #expect(GattCatalog<String>.short("2a19") == "2A19")
        #expect(GattCatalog<String>.propertyLabel(read: true, write: false, writeWithoutResponse: false, notify: true, indicate: false) == "r+ntf")
        #expect(GattCatalog<String>.propertyLabel(read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false) == "-")
    }

    @MainActor
    @Test func lensesDiscoveredAcrossServicesAttach() async throws {
        func lens(_ id: String, _ name: String) -> MockPeripheral {
            let p = MockPeripheral(id, name)
            p.characteristics = Set(discover(Self.currentLayout).entries.keys)
            return p
        }
        let L = lens("L", "Even G2_32_L_ABC"), R = lens("R", "Even G2_32_R_ABC")
        #expect(L.has(G2UUID.write.lowercased()) && L.has(G2UUID.audioNotify))
        var opts = DriverOptions(stepDelayMs: 0, packetGapMs: 0, heartbeatMs: 0, imageAckTimeoutMs: 100)
        opts.authAckTimeoutMs = 10
        opts.contentionWindowMs = 0
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        for p in [L, R] {
            #expect(p.subscribed(G2UUID.notify))
            #expect(p.subscribed(G2UUID.audioNotify))
            #expect(p.writes.contains { $0.characteristic == G2UUID.write })
        }
        g2.close()
    }

    @Test func lc3ToneSurvivesEncodeDecodeAt40ByteFrames() throws {
        let enc = try #require(Liblc3Encoder(bytesPerFrame: 40))
        let dec = try #require(Liblc3Decoder())
        let n = 160, frames = 50
        let src: [Int16] = (0..<(n * frames)).map { Int16((8000 * sin(2 * Double.pi * 440 * Double($0) / 16000)).rounded()) }
        var out: [Int16] = []
        for f in 0..<frames {
            let frame = enc.encode(Array(src[(f * n)..<((f + 1) * n)]))
            #expect(frame.count == 40)
            let pcm = dec.decodeFrame(frame)
            #expect(pcm.count == 160)
            out += pcm
        }
        // LC3 adds a short algorithmic delay; find the best alignment, then check correlation.
        var best = 0.0
        for lag in 0..<200 {
            var num = 0.0, a = 0.0, b = 0.0
            for i in 800..<(src.count - 200) {
                let s = Double(src[i]), o = Double(out[i + lag])
                num += s * o; a += s * s; b += o * o
            }
            if a > 0 && b > 0 { best = max(best, num / (a * b).squareRoot()) }
        }
        #expect(best > 0.95, "correlation \(best)")
        // Packet loss concealment path does not crash and returns a full frame.
        #expect(dec.decodeFrame(nil).count == 160)
    }
}
