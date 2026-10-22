// Port of native/driver/test/driver.test.ts.
import Foundation
import Testing
@testable import G2Kit

@MainActor
@Suite struct DriverTests {
    let W = G2UUID.write
    let fast = DriverOptions(stepDelayMs: 0, packetGapMs: 0, heartbeatMs: 0, imageAckTimeoutMs: 100, authAckTimeoutMs: 0)

    func lenses() -> (L: MockPeripheral, R: MockPeripheral) {
        (MockPeripheral("L", "Even G2_32_L_ABC"), MockPeripheral("R", "Even G2_32_R_ABC"))
    }

    /// Decode everything written to a lens back into (service, protobuf) messages.
    func sent(_ p: MockPeripheral) -> [(service: UInt8, m: PbMessage)] {
        let r = Reassembler()
        return p.writes.filter { $0.characteristic == W }.compactMap { w in
            r.push(w.data).map { ($0.service, PbMessage($0.payload)) }
        }
    }

    func cmds(_ p: MockPeripheral) -> [String] { sent(p).map { "\($0.service):\($0.m.int(1)!)" } }

    /// Reply to every AUTH a lens receives with an ack (secAuth = ok).
    func autoAckAuth(_ p: MockPeripheral, ok: Bool = true) {
        let rx = Reassembler()
        p.onWrite = { _, data in
            guard let msg = rx.push(data), msg.service == 0x80, PbMessage(msg.payload).int(1) == 4 else { return }
            let ack = PbWriter().int(1, 4).int(2, 0).message(3, PbWriter().int(1, ok ? 1 : 0)).finish()
            Task { @MainActor in
                await tick(1)
                rxPackets(0x80, ack).forEach { p.notify(G2UUID.notify, $0) }
            }
        }
    }

    @Test func handshake() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        for p in [L, R] {
            #expect(p.subscribed(G2UUID.notify))
            #expect(p.subscribed(G2UUID.audioNotify))
        }
        // AUTH + TIME_SYNC on both lenses; the right lens also gets the role change and the session init.
        #expect(cmds(L) == ["128:4", "128:128"])
        #expect(cmds(R) == ["128:4", "128:5", "128:128", "16:1", "13:0"])
        #expect(L.writes.allSatisfy { $0.withoutResponse })
        #expect(g2.audioSubscribed == [.left: true, .right: true])
        g2.close()
    }

    @Test func authCarriesIosPhoneTypeAndIsLogged() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var options = fast
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        let authL = try #require(L.writes.compactMap { parsePacket($0.data) }.first { $0.service == 0x80 })
        let authR = try #require(R.writes.compactMap { parsePacket($0.data) }.first { $0.service == 0x80 })
        // {1: 4, 2: magic, 3: {1: true, 2: 3}} with flag 0x00 (device settings)
        #expect(hex(authL.chunk) == "080410001a0408011003")
        #expect(hex(authR.chunk) == "080410011a0408011003")
        #expect(authL.status == 0x00 && authR.status == 0x00)
        #expect(hex(DevConfig.auth(magic: 7, phoneType: PhoneType.android)) == "080410071a0408011004")
        #expect(messages.contains("AUTH → L phoneType 3"))
        #expect(messages.contains("AUTH → R phoneType 3"))
        #expect(messages.contains("L AUTH no ack in 0 ms"))
        #expect(g2.authenticated == [.left: false, .right: false])
        g2.close()
    }

    @Test func authAcksAreAwaitedPerLens() async throws {
        let (L, R) = lenses()
        autoAckAuth(L)
        autoAckAuth(R, ok: false)
        var messages: [String] = []
        var options = fast
        options.authAckTimeoutMs = 2000
        options.log = { messages.append($0) }
        let started = Date()
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(Date().timeIntervalSince(started) < 1.5, "acks should end the wait early")
        #expect(g2.authenticated == [.left: true, .right: false])
        #expect(messages.contains { $0.hasPrefix("L AUTH ack ok in ") && $0.hasSuffix(" ms") })
        #expect(messages.contains { $0.hasPrefix("R AUTH ack rejected") })
        #expect(messages.contains { $0.hasPrefix("handshake sent") })
        g2.close()
    }

    /// What run 2 on hardware showed: each lens first answers AUTH without a secAuth verdict, then with
    /// secAuth = true. The first reply must not count as a rejection or end the wait early.
    @Test func authReplyWithoutVerdictWaitsForTheVerdict() async throws {
        let (L, R) = lenses()
        for (p, first) in [(L, PbWriter().int(1, 4).int(2, 0).finish()), (R, PbWriter().int(1, 4).int(2, 1).message(3, [UInt8]()).finish())] {
            let rx = Reassembler()
            p.onWrite = { _, data in
                guard let msg = rx.push(data), msg.service == 0x80, PbMessage(msg.payload).int(1) == 4 else { return }
                let verdict = PbWriter().int(1, 4).int(2, 0).message(3, PbWriter().int(1, 1)).finish()
                Task { @MainActor in
                    await tick(1)
                    rxPackets(0x80, first).forEach { p.notify(G2UUID.notify, $0) }
                    await tick(20)
                    rxPackets(0x80, verdict, syncId: 0x41).forEach { p.notify(G2UUID.notify, $0) }
                }
            }
        }
        var messages: [String] = []
        var options = fast
        options.authAckTimeoutMs = 2000
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(g2.authenticated == [.left: true, .right: true])
        #expect(messages.contains { $0.hasPrefix("L AUTH ack ok in ") })
        #expect(messages.contains { $0.hasPrefix("R AUTH ack ok in ") })
        #expect(messages.contains("L AUTH reply without a secAuth verdict (08041000); waiting for the verdict"))
        #expect(messages.contains("R AUTH reply without a secAuth verdict (080410011a00); waiting for the verdict"))
        #expect(!messages.contains { $0.contains("rejected") || $0.contains("(late)") }, "\(messages)")
        g2.close()
    }

    @Test func verdictlessAuthReplyNeverUnauthenticatesALens() async throws {
        let (L, R) = lenses()
        autoAckAuth(L)
        autoAckAuth(R)
        var options = fast
        options.authAckTimeoutMs = 2000
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        var events: [DriverEvent] = []
        g2.onEvent { events.append($0) }
        rxPackets(0x80, PbWriter().int(1, 4).int(2, 3).finish(), syncId: 0x50).forEach { R.notify(G2UUID.notify, $0) }
        #expect(g2.authenticated == [.left: true, .right: true])
        #expect(events.isEmpty)
        g2.close()
    }

    @Test func verdictlessAuthReplyAloneTimesOutUnauthenticated() async throws {
        let (L, R) = lenses()
        let rx = Reassembler()
        L.onWrite = { _, data in
            guard let msg = rx.push(data), msg.service == 0x80, PbMessage(msg.payload).int(1) == 4 else { return }
            Task { @MainActor in
                await tick(1)
                rxPackets(0x80, PbWriter().int(1, 4).int(2, 0).finish()).forEach { L.notify(G2UUID.notify, $0) }
            }
        }
        var messages: [String] = []
        var options = fast
        options.authAckTimeoutMs = 40
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(g2.authenticated == [.left: false, .right: false])
        #expect(messages.contains("L AUTH replied without a secAuth verdict, and no verdict followed in 40 ms"))
        #expect(messages.contains("R AUTH no ack in 40 ms"))
        g2.close()
    }

    @Test func lensLostDuringTheLastHandshakeStepFailsAttach() async {
        let (L, R) = lenses()
        // The left lens drops right after the last handshake write (gesture_ctrl init to R): no further
        // write to L would notice, and nobody listens for `.disconnected` yet.
        R.onWrite = { _, data in if parsePacket(data)?.service == Service.gestureCtrl { L.disconnect() } }
        do {
            let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
            Issue.record("attach returned a session whose left lens is gone")
            g2.close()
        } catch {
            #expect(error as? DriverError == .lensDisconnected(.left))
        }
        #expect(!L.connected && !R.connected)
    }

    @Test func missingAuthAckIsNotFatal() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var options = fast
        options.authAckTimeoutMs = 30
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(messages.contains("L AUTH no ack in 30 ms"))
        #expect(messages.contains("R AUTH no ack in 30 ms"))
        #expect(cmds(R).count == 5)
        g2.close()
    }

    @Test func sessionInitCanBeTurnedOff() async throws {
        let (L, R) = lenses()
        var options = fast
        options.sessionInit = false
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(cmds(L) == ["128:4", "128:128"])
        #expect(cmds(R) == ["128:4", "128:5", "128:128"])
        g2.close()
    }

    @Test func sessionInitBytesMatchMentraOS() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let pkts = R.writes.compactMap { parsePacket($0.data) }
        let onboarding = try #require(pkts.first { $0.service == 0x10 })
        let gesture = try #require(pkts.first { $0.service == 0x0D })
        // magics: L auth 0, R auth 1, role 2, time 3, onboarding 4, gesture 5
        #expect(hex(onboarding.chunk) == "080110041a020804")
        #expect(hex(gesture.chunk) == "08001005")
        #expect(onboarding.status == 0x20 && gesture.status == 0x20)
        // TIME_SYNC is the same message on both lenses.
        let timeL = try #require(sent(L).first { $0.m.int(1) == 128 })
        let timeR = try #require(sent(R).first { $0.m.int(1) == 128 })
        #expect(timeL.m.int(2) == 3 && timeR.m.int(2) == 3)
        g2.close()
    }

    enum AttachFailure: Error, Equatable { case subscription, handshake }

    @Test func failedNotifySubscriptionClosesBothLensesAndEarlierSubscriptions() async {
        let (L, R) = lenses()
        R.subscriptionErrors[G2UUID.notify] = AttachFailure.subscription
        do {
            let unexpected = try await G2Driver.attach(left: L, right: R, options: fast)
            Issue.record("Attachment succeeded despite the forced subscription failure")
            unexpected.close()
            return
        } catch {
            #expect(error as? AttachFailure == .subscription)
        }
        #expect(!L.connected && !R.connected)
        #expect(L.unsubscribeCalls == [G2UUID.notify, G2UUID.audioNotify])
        #expect(R.unsubscribeCalls == [])
        for p in [L, R] {
            #expect(!p.subscribed(G2UUID.notify))
            #expect(!p.subscribed(G2UUID.audioNotify))
            #expect(p.writes.isEmpty)
        }
    }

    @Test func failedAudioSubscriptionIsNotFatal() async throws {
        let (L, R) = lenses()
        R.subscriptionErrors[G2UUID.audioNotify] = AttachFailure.subscription
        var messages: [String] = []
        var options = fast
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(L.subscribed(G2UUID.audioNotify))
        #expect(R.subscribed(G2UUID.notify) && !R.subscribed(G2UUID.audioNotify))
        #expect(g2.audioSubscribed == [.left: true, .right: false])
        #expect(messages.contains { $0.hasPrefix("R audio 6402 subscribe failed") })
        #expect(cmds(R) == ["128:4", "128:5", "128:128", "16:1", "13:0"])
        g2.close()
        #expect(R.unsubscribeCalls == [G2UUID.notify])
    }

    @Test func lensWithoutAudioCharacteristicSkipsTheMic() async throws {
        let (L, R) = lenses()
        L.characteristics.remove(G2UUID.audioNotify)
        var messages: [String] = []
        var options = fast
        options.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: options)
        #expect(L.subscribed(G2UUID.notify) && !L.subscribed(G2UUID.audioNotify))
        #expect(R.subscribed(G2UUID.audioNotify))
        #expect(messages.contains("L has no audio characteristic 6402 (continuing without this mic)"))
        #expect(cmds(L) == ["128:4", "128:128"])
        g2.close()
    }

    @Test func failedHandshakeClosesBothLensesAndAllSubscriptions() async {
        let (L, R) = lenses()
        R.writeError = AttachFailure.handshake
        var messages: [String] = []
        var options = fast
        options.log = { messages.append($0) }
        do {
            let unexpected = try await G2Driver.attach(left: L, right: R, options: options)
            Issue.record("Attachment succeeded despite the forced handshake failure")
            unexpected.close()
            return
        } catch {
            #expect(error as? AttachFailure == .handshake)
        }
        #expect(!L.connected && !R.connected)
        for p in [L, R] {
            #expect(p.unsubscribeCalls == [G2UUID.notify, G2UUID.audioNotify])
            #expect(!p.subscribed(G2UUID.notify))
            #expect(!p.subscribed(G2UUID.audioNotify))
        }
        #expect(sent(L).count == 1)
        #expect(R.writes.isEmpty)
        #expect(!messages.contains { $0.hasPrefix("handshake sent") })
    }

    @Test func authAckMarksLens() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let ack = PbWriter().int(1, 4).int(2, 0).message(3, PbWriter().int(1, 1)).finish()
        for p in rxPackets(0x80, ack) { R.notify(G2UUID.notify, p) }
        #expect(g2.authenticated == [.left: false, .right: true])
        g2.close()
    }

    @Test func createThenRebuildOnRightLensOnly() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let page = PageSpec(text: [TextContainer(id: 1, x: 0, y: 0, width: 576, height: 288, captureEvents: true, content: "a")])
        try await g2.createPage(page)
        try await g2.createPage(page)
        try await g2.setText(1, "b")
        #expect(sent(R).filter { $0.service == 0xE0 }.map { $0.m.int(1)! } == [0, 7, 5])
        #expect(sent(L).allSatisfy { $0.service == 0x80 })
        #expect(R.writes.filter { parsePacket($0.data)!.service == 0xE0 }.allSatisfy { $0.data[7] == 0x20 })
        g2.close()
    }

    @Test func multiPacketMessagesNeverInterleave() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.packetGapMs = 2
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        R.writes.removeAll()
        let long = String(repeating: "x", count: 900)
        async let a: Void = g2.setText(1, long)
        async let b: Void = g2.setText(2, long)
        async let c: Void = g2.setText(3, "short")
        _ = try await (a, b, c)
        let syncs = R.writes.map { $0.data[2] }
        var runs: [UInt8] = []
        for (i, s) in syncs.enumerated() where i == 0 || s != syncs[i - 1] { runs.append(s) }
        #expect(Set(runs).count == runs.count, "interleaved: \(syncs)")
        #expect(runs.count == 3)
        g2.close()
    }

    @Test func imageUploadWaitsForEachAck() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let rx = Reassembler()
        R.onWrite = { _, data in
            guard let msg = rx.push(data), msg.service == 0xE0 else { return }
            let m = PbMessage(msg.payload)
            guard m.int(1) == 3, let f = m.message(5) else { return }
            let ack = PbWriter().int(1, 4).int(2, 0)
                .message(6, PbWriter().int(1, f.int(1)!).int(3, f.int(3)!).int(6, f.int(6) ?? 0).int(8, 4)).finish()
            Task { @MainActor in
                await tick(1)
                rxPackets(0xE0, ack).forEach { R.notify(G2UUID.notify, $0) }
            }
        }
        let ok = try await g2.setImage(5, image: GrayImage.solid(width: 288, height: 144, level: 200), containerName: "img")
        #expect(ok)
        #expect(sent(R).filter { $0.service == 0xE0 && $0.m.int(1) == 3 }.count == 6)
        g2.close()
    }

    @Test func imageUploadRetriesThenGivesUp() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.imageAttempts = 2
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        let rx = Reassembler()
        R.onWrite = { _, data in
            guard let msg = rx.push(data) else { return }
            let m = PbMessage(msg.payload)
            guard m.int(1) == 3, let f = m.message(5) else { return }
            let nack = PbWriter().int(1, 4).message(6, PbWriter().int(3, f.int(3)!).int(6, f.int(6) ?? 0).int(8, 5)).finish()
            Task { @MainActor in
                await tick(1)
                rxPackets(0xE0, nack).forEach { R.notify(G2UUID.notify, $0) }
            }
        }
        #expect(try await g2.setImage(5, bmp: [UInt8](repeating: 0, count: 100)) == false)
        let sessions = sent(R).filter { $0.m.int(1) == 3 }.map { $0.m.message(5)!.int(3) }
        #expect(sessions == [1, 2])
        g2.close()
    }

    @Test func imageUploadTimesOutWithoutAck() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.imageAttempts = 1
        opts.imageAckTimeoutMs = 30
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        #expect(try await g2.setImage(5, bmp: [UInt8](repeating: 0, count: 100)) == false)
        g2.close()
    }

    /// ACK every image fragment the right lens receives after `delayMs` (code from `code`, default ok),
    /// recording "f<i>" when a fragment arrives and "a<i>" when its ACK is delivered.
    func ackImages(_ R: MockPeripheral, delayMs: Int = 0, code: @escaping (_ session: Int, _ index: Int) -> Int = { _, _ in 4 }) -> () -> [String] {
        let rx = Reassembler()
        var order: [String] = []
        R.onWrite = { _, data in
            guard let msg = rx.push(data), msg.service == 0xE0 else { return }
            let m = PbMessage(msg.payload)
            guard m.int(1) == 3, let f = m.message(5) else { return }
            let session = f.int(3)!, index = f.int(6) ?? 0
            order.append("f\(index)")
            let ack = PbWriter().int(1, 4).int(2, 0)
                .message(6, PbWriter().int(1, f.int(1)!).int(3, session).int(6, index).int(8, code(session, index))).finish()
            Task { @MainActor in
                await tick(delayMs)
                order.append("a\(index)")
                rxPackets(0xE0, ack).forEach { R.notify(G2UUID.notify, $0) }
            }
        }
        return { order }
    }

    let tile = GrayImage.solid(width: 288, height: 144, level: 200)

    @Test func imageFragmentsPipelineTwoInFlight() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let order = ackImages(R, delayMs: 5)
        #expect(try await g2.setImage(5, image: tile, containerName: "img"))
        // The next fragment is written before the previous one is ACKed, never more than 2 ahead.
        let o = order()
        #expect(o.firstIndex(of: "f1")! < o.firstIndex(of: "a0")!)
        var unacked = 0, most = 0
        for e in o { unacked += e.hasPrefix("f") ? 1 : -1; most = max(most, unacked) }
        #expect(most == 2 && unacked == 0 && o.count == 12)
        let st = try #require(g2.lastImage)
        #expect(st.ok && st.fragments == 6 && st.attempts == 1 && st.bytes == 20854 && st.mode == "flow+w2")
        #expect(st.packets == 92)
        g2.close()
    }

    @Test func imageWindowOneWaitsForEachAck() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.imageWindow = 1
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        let order = ackImages(R, delayMs: 2)
        #expect(try await g2.setImage(5, image: tile))
        #expect(order() == ["f0", "a0", "f1", "a1", "f2", "a2", "f3", "a3", "f4", "a4", "f5", "a5"])
        #expect(g2.lastImage?.mode == "flow")
        g2.close()
    }

    @Test func imagePacketsWaitForTheWriteBufferOnly() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        _ = ackImages(R)
        let before = R.writes.count
        #expect(R.writableCalls == 0) // handshake messages keep the fixed gap
        #expect(try await g2.setImage(5, image: tile))
        let imagePackets = R.writes.count - before
        #expect(imagePackets == 92) // 5 x 18 packets for the 4 KB fragments + 2 for the last
        #expect(R.writableCalls == imagePackets)
        #expect(g2.lastImage?.packets == imagePackets)
        try await g2.setText(1, "hello")
        #expect(R.writableCalls == imagePackets)
        g2.close()
    }

    @Test func imageWithoutFlowControlUsesTheGap() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.imageFlowControl = false
        opts.imageWindow = 1
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        _ = ackImages(R)
        #expect(try await g2.setImage(5, image: tile))
        #expect(R.writableCalls == 0)
        #expect(g2.lastImage?.mode == "gap0")
        g2.close()
    }

    @Test func writeBufferTimeoutFallsBackToTheGapForThatImage() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        _ = ackImages(R)
        R.writable = false
        #expect(try await g2.setImage(5, image: tile))
        let st = try #require(g2.lastImage)
        // One timed-out wait, then the fixed gap for the rest of the image (no more waits).
        #expect(st.stalls == 1 && st.stallTimeouts == 1 && st.packets == 92)
        #expect(R.writableCalls == 1)
        R.writable = true
        #expect(try await g2.setImage(5, image: tile))
        #expect(g2.lastImage?.stallTimeouts == 0)
        #expect(R.writableCalls == 1 + 92)
        g2.close()
    }

    @Test func failedImageStepsPacingDownForTheSession() async throws {
        let (L, R) = lenses()
        var logs: [String] = []
        var opts = fast
        opts.log = { logs.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        // Session 1 (fast) fails on its second fragment; the retry (session 2) goes through.
        _ = ackImages(R) { session, index in session == 1 && index == 1 ? 5 : 4 }
        #expect(try await g2.setImage(5, image: tile))
        var st = try #require(g2.lastImage)
        #expect(st.attempts == 2 && st.ok && st.mode == "flow")
        #expect(logs.contains { $0.contains("one fragment in flight from now on") })
        // Still window 1 for the next image; another failure drops flow control too.
        _ = ackImages(R) { session, index in session == 3 ? 5 : 4 }
        #expect(try await g2.setImage(5, image: tile))
        st = try #require(g2.lastImage)
        #expect(st.attempts == 2 && st.mode == "gap0")
        #expect(logs.contains { $0.contains("fixed 0 ms packet gap from now on") })
        g2.close()
    }

    /// Compress modes of the image fragments written to the right lens, per session id.
    func imageModes(_ R: MockPeripheral) -> [Int: Set<Int>] {
        var out: [Int: Set<Int>] = [:]
        for (_, m) in sent(R) where m.int(1) == 3 {
            let f = m.message(5)!
            out[f.int(3)!, default: []].insert(f.int(5) ?? 0)
        }
        return out
    }

    @Test func experimentalFormatIsSentWhenAccepted() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        _ = ackImages(R)
        #expect(try await g2.setImage(5, image: tile, format: .lz4))
        let st = try #require(g2.lastImage)
        #expect(st.format == .lz4 && st.ok && st.fragments == 1 && st.payloadBytes < 1000)
        #expect(st.summary.contains("lz4 0."))
        #expect(imageModes(R) == [1: [2]])
        g2.close()
    }

    @Test func rejectedExperimentalFormatFallsBackToStandardForTheSession() async throws {
        let (L, R) = lenses()
        var logs: [String] = []
        var opts = fast
        opts.log = { logs.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        var rle4Sessions: Set<Int> = []
        let rx = Reassembler()
        // NAK anything that is not a plain BMP (an RLE4 header has biCompression 2 at byte 30).
        R.onWrite = { _, data in
            guard let msg = rx.push(data), msg.service == 0xE0 else { return }
            let m = PbMessage(msg.payload)
            guard m.int(1) == 3, let f = m.message(5) else { return }
            let session = f.int(3)!, index = f.int(6) ?? 0
            let bytes = f.bytes(8) ?? []
            if index == 0, bytes.count > 30, bytes[30] == 2 { rle4Sessions.insert(session) }
            let code = rle4Sessions.contains(session) ? 5 : 4
            let ack = PbWriter().int(1, 4).message(6, PbWriter().int(3, session).int(6, index).int(8, code)).finish()
            Task { @MainActor in
                await tick(1)
                rxPackets(0xE0, ack).forEach { R.notify(G2UUID.notify, $0) }
            }
        }
        #expect(try await g2.setImage(5, image: tile, format: .rle4))
        var st = try #require(g2.lastImage)
        #expect(st.ok && st.attempts == 2 && st.format == .standard && st.mode == "flow+w2") // pacing untouched
        #expect(g2.rejectedFormats == [.rle4])
        #expect(logs.contains { $0.contains("rle4 rejected by the glasses; standard BMP from now on") })
        // The next push goes straight out as a standard BMP.
        #expect(try await g2.setImage(5, image: tile, format: .rle4))
        st = try #require(g2.lastImage)
        #expect(st.attempts == 1 && st.format == .standard)
        // Forced (LENS TEST): the format itself, its own result, no standard retry.
        let before = rle4Sessions.count
        #expect(try await g2.setImage(5, image: tile, format: .rle4, force: true) == false)
        #expect(rle4Sessions.count == before + 1)
        st = try #require(g2.lastImage)
        #expect(st.attempts == 1 && st.format == .rle4 && !st.ok)
        g2.close()
    }

    @Test func inputFromRingAndTempleWithEchoDropped() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        var got: [String] = []
        g2.onInput { got.append("\($0.gesture.rawValue)/\($0.source.rawValue)") }
        func ev(_ type: Int, _ src: Int) -> [[UInt8]] {
            rxPackets(0xE0, PbWriter().int(1, 2).message(13, PbWriter().message(3, PbWriter().int(1, type).int(2, src))).finish())
        }
        ev(3, 2).forEach { R.notify(G2UUID.notify, $0) }
        ev(3, 2).forEach { L.notify(G2UUID.notify, $0) } // echo
        ev(0, 1).forEach { R.notify(G2UUID.notify, $0) }
        #expect(got == ["double_tap/ring", "tap/glasses_right"])
        ev(7, 0).forEach { R.notify(G2UUID.notify, $0) }
        #expect(g2.pageAlive == false)
        g2.close()
    }

    final class FakeLC3: Lc3Decoding {
        func decodeFrame(_ frame: [UInt8]?) -> [Int16] { [Int16](repeating: 1, count: 160) }
    }

    @Test func micDeliversDecodedPCMOnce() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.lc3 = FakeLC3()
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        var chunks: [(frames: Int, pcm: Int)] = []
        try await g2.startMic { chunks.append(($0.lc3Frames.count, $0.pcm?.count ?? 0)) }
        let audio = [UInt8](repeating: 9, count: 205)
        L.notify(G2UUID.audioNotify, audio)
        R.notify(G2UUID.audioNotify, audio)
        #expect(chunks.count == 1)
        #expect(chunks.first?.frames == 5)
        #expect(chunks.first?.pcm == 5 * 160 * 2)
        let last = try #require(sent(R).last)
        #expect(last.m.int(1) == 15)
        #expect(last.m.message(18)?.int(1) == 1)
        g2.close()
    }

    @Test func heartbeatDevAlwaysEvenHubOncePageExists() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.heartbeatMs = 20
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        await tick(45)
        try await g2.createPage(PageSpec(text: [TextContainer(id: 1, x: 0, y: 0, width: 100, height: 100, captureEvents: true)]))
        await tick(45)
        g2.close()
        let cmds = sent(R).map { "\(String($0.service, radix: 16)):\($0.m.int(1)!)" }
        #expect(cmds.contains("80:14"), "\(cmds)")
        #expect(cmds.contains("e0:12"), "\(cmds)")
        if let hb = cmds.firstIndex(of: "e0:12"), let create = cmds.firstIndex(of: "e0:0") { #expect(hb > create) }
        // Dev-settings heartbeat on the left lens too; EvenHub heartbeat stays on the right.
        let left = sent(L).map { "\(String($0.service, radix: 16)):\($0.m.int(1)!)" }
        #expect(left.contains("80:14"), "\(left)")
        #expect(!left.contains("e0:12"), "\(left)")
    }

    @Test func heartbeatContentionIsReported() async throws {
        let (L, R) = lenses()
        // R answers every dev heartbeat twice (as if a second app also sent one); L answers once.
        for (p, n) in [(L, 1), (R, 2)] {
            let rx = Reassembler()
            p.onWrite = { _, data in
                guard let msg = rx.push(data), msg.service == 0x80, PbMessage(msg.payload).int(1) == 14 else { return }
                let reply = PbWriter().int(1, 14).int(2, 0).message(13, [UInt8]()).finish()
                Task { @MainActor in
                    await tick(1)
                    for _ in 0..<n { rxPackets(0x80, reply).forEach { p.notify(G2UUID.notify, $0) } }
                }
            }
        }
        var messages: [String] = []
        var opts = fast
        opts.heartbeatMs = 10
        opts.contentionWindowMs = 120
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        await tick(200)
        g2.close()
        let r = try #require(messages.first { $0.hasPrefix("R 0x80 replies ") })
        let l = try #require(messages.first { $0.hasPrefix("L 0x80 replies ") })
        #expect(r.hasSuffix("— another app is driving this link (Even app?)"), "\(r)")
        #expect(r.contains("sent in 120 ms"), "\(r)")
        #expect(!l.contains("another app"), "\(l)")
    }

    @Test func rejectedPacketsAreLogged() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        let ack = PbWriter().int(1, 4).int(2, 0).message(3, PbWriter().int(1, 1)).finish()
        rxPackets(0x80, ack, syncId: 12, status: 3 << 1).forEach { L.notify(G2UUID.notify, $0) }
        #expect(messages.contains("RX rejected L svc 0x80 sync 12 result 3"))
        #expect(g2.authenticated[.left] == false)
        g2.close()
    }

    @Test func deviceInfoReplyUpdatesBattery() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        let reply = PbWriter().int(1, 2).message(4, PbWriter().int(12, 64).int(13, 0)).finish()
        R.onWrite = { _, data in
            guard parsePacket(data)?.service == 0x09 else { return }
            Task { @MainActor in
                await tick(1)
                rxPackets(0x09, reply).forEach { R.notify(G2UUID.notify, $0) }
            }
        }
        let info = try await g2.requestDeviceInfo(timeoutMs: 500)
        #expect(info == DeviceInfo(battery: 64, charging: false))
        g2.close()
    }

    @Test func dashboardPreludeMatchesCapture() async throws {
        let (L, R) = lenses()
        var opts = fast
        opts.dashboardPrelude = true
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        let dash = try #require(R.writes.compactMap { parsePacket($0.data) }.first { $0.service == 0x01 })
        // Captured: 08 02 10 9c01 22 0a 1a 08 12 06 12 04 08 00 10 00 (magic 0x9c there, 6 here:
        // after AUTH L/R, role, time sync, onboarding skip, gesture init)
        #expect(hex(dash.chunk) == "08021006220a1a0812061204080010" + "00")
        g2.close()
    }

    let ringMac: [UInt8] = [0xBA, 0xC5, 0xCE, 0x33, 0x22, 0x11]

    @Test func bindRingSendsExactRingConnectInfoToTheRightLens() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        let leftBefore = L.writes.count
        R.writes.removeAll()
        try await g2.bindRing(macRaw: ringMac, connect: true, ringName: "EVEN R1_CEC5BA")
        #expect(L.writes.count == leftBefore)
        let pkt = try #require(R.writes.compactMap { parsePacket($0.data) }.first)
        #expect(pkt.service == 0x80 && pkt.status == 0x00)
        let name = hex(Array("EVEN R1_CEC5BA".utf8))
        // 08 06 10 <m> 2a <len> 08 01 12 06 <mac6> 1a <n> <name>; magic 6 follows the handshake's 0...5
        #expect(hex(pkt.chunk) == "08061006" + "2a1a" + "0801" + "1206" + "bac5ce332211" + "1a0e" + name)
        #expect(messages.contains("ring: RING_CONNECT_INFO → R mac BA:C5:CE:33:22:11 (raw) name EVEN R1_CEC5BA"))
        await #expect(throws: RingError.badMac(count: 3)) { try await g2.bindRing(macRaw: [1, 2, 3], connect: true, ringName: nil) }
        g2.close()
    }

    @Test func ringRepliesBecomeRingEvents() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        var rings: [RingStatus] = []
        g2.onEvent { if case let .ring(s) = $0 { rings.append(s) } }
        let linked = PbWriter().int(1, 6).int(2, 9).message(5, PbWriter().int(1, 1).bytes(2, ringMac).int(4, 62).int(5, 0)).finish()
        rxPackets(0x80, linked).forEach { R.notify(G2UUID.notify, $0) }
        let dropped = PbWriter().int(1, 6).int(2, 9).message(5, PbWriter().int(4, 22)).finish()
        rxPackets(0x80, dropped, syncId: 0x41).forEach { R.notify(G2UUID.notify, $0) }
        let disc = PbWriter().int(1, 8).message(7, PbWriter().int(1, 0).bytes(2, ringMac).int(3, 90)).finish()
        rxPackets(0x80, disc, syncId: 0x42).forEach { R.notify(G2UUID.notify, $0) }
        let unpair = PbWriter().int(1, 9).message(8, PbWriter().int(1, 0).bytes(2, ringMac).int(3, 0)).finish()
        rxPackets(0x80, unpair, syncId: 0x43).forEach { L.notify(G2UUID.notify, $0) }
        #expect(rings == [
            RingStatus(connect: 1, macRaw: ringMac, connStatus: 62, result: 0, cmd: 6),
            RingStatus(connStatus: 22, cmd: 6),
            RingStatus(macRaw: ringMac, result: 90, cmd: 8),
            RingStatus(macRaw: ringMac, result: 0, cmd: 9),
        ])
        #expect(rings[0].linked && !rings[0].needsRebind)
        #expect(rings[1].needsRebind && !rings[1].linked)
        #expect(g2.ringStatus == rings[3])
        #expect(messages.contains("ring: status from R connect=1 connStatus=62 result=0 mac BA:C5:CE:33:22:11 (raw) (linked)"))
        #expect(messages.contains { $0.hasPrefix("ring: status from R connect=- connStatus=22 result=-") })
        #expect(messages.contains { $0.hasPrefix("ring: status from R disconnect-info result=90") && $0.contains("RING_CONNECT_TIMEOUT") })
        #expect(messages.contains { $0.hasPrefix("ring: status from L unpair-info result=0") })
        g2.close()
    }

    @Test func emptyRingConnectInfoAckKeepsTheLastRealStatus() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        var rings: [RingStatus] = []
        g2.onEvent { if case let .ring(s) = $0 { rings.append(s) } }
        let linked = PbWriter().int(1, 6).int(2, 9).message(5, PbWriter().int(1, 1).int(4, 62)).finish()
        rxPackets(0x80, linked).forEach { R.notify(G2UUID.notify, $0) }
        // Both lenses then acknowledge the next RING_CONNECT_INFO with an empty reply (seen on hardware).
        rxPackets(0x80, PbWriter().int(1, 6).int(2, 10).finish(), syncId: 0x41).forEach { R.notify(G2UUID.notify, $0) }
        rxPackets(0x80, PbWriter().int(1, 6).int(2, 10).finish(), syncId: 0x42).forEach { L.notify(G2UUID.notify, $0) }
        #expect(rings.count == 3 && rings[1].isAckOnly && rings[2].isAckOnly)
        #expect(g2.ringStatus == RingStatus(connect: 1, connStatus: 62, cmd: 6))
        #expect(messages.contains("ring: status from L connect=- connStatus=- result=- (ack, no ring state)"))
        g2.close()
    }

    @Test func ringServicesAreLoggedRaw() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        rxPackets(0x90, [0x08, 0x01, 0x10, 0x02]).forEach { R.notify(G2UUID.notify, $0) }
        rxPackets(0x91, [0xAB], syncId: 0x41).forEach { L.notify(G2UUID.notify, $0) }
        #expect(messages.contains("RX R svc 0x90 08011002"))
        #expect(messages.contains("RX L svc 0x91 ab"))
        g2.close()
    }

    @Test func ringActivityMarkerIsLoggedAndStillATap() async throws {
        let (L, R) = lenses()
        var messages: [String] = []
        var opts = fast
        opts.log = { messages.append($0) }
        let g2 = try await G2Driver.attach(left: L, right: R, options: opts)
        var got: [String] = []
        g2.onInput { got.append("\($0.gesture.rawValue)/\($0.source.rawValue)") }
        // Sys event with only source = 2 (proto3 dropped type CLICK = 0).
        rxPackets(0xE0, PbWriter().int(1, 2).message(13, PbWriter().message(3, PbWriter().int(2, 2))).finish()).forEach { R.notify(G2UUID.notify, $0) }
        #expect(got == ["tap/ring"])
        #expect(g2.ringActivityCount == 1)
        #expect(messages.contains { $0.hasPrefix("input: ring activity marker") })
        g2.close()
    }

    @Test func disconnectIsReported() async throws {
        let (L, R) = lenses()
        let g2 = try await G2Driver.attach(left: L, right: R, options: fast)
        var events: [DriverEvent] = []
        g2.onEvent { events.append($0) }
        L.disconnect()
        #expect(events == [.disconnected(.left)])
        g2.close()
    }
}
