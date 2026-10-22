import Foundation
import Testing
@testable import G2Kit

@MainActor
@Suite struct ConnectionTests {
    enum Failure: Error, Equatable { case left, right, attachment }

    @Test func rightFailureReleasesLeftBeforeRetry() async {
        let left = MockPeripheral("L", "Even G2_32_L_ABC")
        var attached = false
        do {
            let _: Bool = try await connectG2Pair(left: { left }, right: { throw PhaseError("discovery", Failure.right) }, attach: { _, _ in
                attached = true
                return true
            })
            Issue.record("A failed right connection must not succeed")
        } catch {
            let e = error as? PairConnectError
            #expect(e?.error(.left) == nil)
            #expect(e?.error(.right) is PhaseError)
            #expect("\(error)" == "Left: ok · Right: discovery: right")
        }
        #expect(!left.connected)
        #expect(!attached)
    }

    @Test func leftFailureStillTriesRightThenReleasesIt() async {
        let right = MockPeripheral("R", "Even G2_32_R_ABC")
        var rightTried = false
        do {
            let _: Bool = try await connectG2Pair(left: { () async throws -> MockPeripheral in throw Failure.left }, right: {
                rightTried = true
                return right
            }, attach: { _, _ in true })
            Issue.record("A failed left connection must not succeed")
        } catch {
            #expect((error as? PairConnectError)?.error(.left) as? Failure == .left)
            #expect((error as? PairConnectError)?.error(.right) == nil)
            #expect("\(error)" == "Left: left · Right: ok")
        }
        #expect(rightTried)
        #expect(!right.connected)
    }

    @Test func bothArmsConnectConcurrently() async throws {
        let left = MockPeripheral("L", "Even G2_32_L_ABC")
        let right = MockPeripheral("R", "Even G2_32_R_ABC")
        var leftStarted = false, rightStarted = false
        // Each side waits until the other has started; a sequential connect would never get there.
        func waitFor(_ other: () -> Bool) async throws {
            for _ in 0..<1000 where !other() { await Task.yield() }
            if !other() { throw Failure.attachment }
        }
        let value = try await connectG2Pair(left: {
            leftStarted = true
            try await waitFor { rightStarted }
            return left
        }, right: {
            rightStarted = true
            try await waitFor { leftStarted }
            return right
        }, attach: { _, _ in "session" })
        #expect(value == "session")
    }

    @Test func bothFailuresAreReportedPerArm() async {
        do {
            let _: Bool = try await connectG2Pair(left: { () async throws -> MockPeripheral in throw PhaseError("connect", BleTestError.timeout) },
                                                  right: { throw PhaseError("discovery", Failure.right) },
                                                  attach: { _, _ in true })
            Issue.record("must fail")
        } catch {
            #expect("\(error)" == "Left: connect: no answer · Right: discovery: right")
        }
        do {
            let _: Bool = try await connectG2Pair(left: { () async throws -> MockPeripheral in throw CancellationError() },
                                                  right: { throw CancellationError() },
                                                  attach: { _, _ in true })
            Issue.record("must fail")
        } catch {
            #expect(error is CancellationError)
        }
    }

    @Test func attachmentFailureReleasesBothArms() async {
        let left = MockPeripheral("L", "Even G2_32_L_ABC")
        let right = MockPeripheral("R", "Even G2_32_R_ABC")
        do {
            let _: Bool = try await connectG2Pair(left: { left }, right: { right }, attach: { _, _ in throw Failure.attachment })
            Issue.record("A failed attachment must not succeed")
        } catch { #expect(error as? Failure == .attachment) }
        #expect(!left.connected && !right.connected)
    }

    @Test func successfulSessionKeepsBothConnections() async throws {
        let left = MockPeripheral("L", "Even G2_32_L_ABC")
        let right = MockPeripheral("R", "Even G2_32_R_ABC")
        let value = try await connectG2Pair(left: { left }, right: { right }, attach: { _, _ in "session" })
        #expect(value == "session")
        #expect(left.connected && right.connected)
    }

    @Test func nsErrorsShowDomainAndCode() {
        let e = NSError(domain: "CBErrorDomain", code: 14, userInfo: [NSLocalizedDescriptionKey: "Peer removed pairing information"])
        #expect(describeBleError(e) == "Peer removed pairing information (CBError 14)")
        #expect(PhaseError("connect", e).description == "connect: Peer removed pairing information (CBError 14)")
    }
}

private enum BleTestError: Error, CustomStringConvertible {
    case timeout
    var description: String { "no answer" }
}
