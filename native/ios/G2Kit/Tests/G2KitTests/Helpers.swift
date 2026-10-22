import Foundation
@testable import G2Kit

/// Build what the glasses would send: same framing with route 0x12 and status 0x00. (test/helpers.ts)
func rxPackets(_ service: UInt8, _ payload: [UInt8], syncId: UInt8 = 0x40, status: UInt8 = 0) -> [[UInt8]] {
    try! buildPackets(payload, syncId: syncId, service: service, flag: status).map { p in
        var q = p
        q[1] = 0x12
        return q
    }
}

func tick(_ ms: Int = 0) async {
    try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000 + 1_000)
}

/// In-memory peripheral (driver/src/transports/mock.ts).
@MainActor
final class MockPeripheral: BlePeripheral {
    struct Write { let characteristic: String; let data: [UInt8]; let withoutResponse: Bool }
    let id: String
    let name: String
    var writes: [Write] = []
    var onWrite: ((String, [UInt8]) -> Void)?
    var writeError: Error?
    var subscriptionErrors: [String: Error] = [:]
    /// The GATT characteristics this lens exposes (`has`); drop 6402 to model a lens without audio.
    var characteristics: Set<String> = [G2UUID.write, G2UUID.notify, G2UUID.audioNotify]
    private(set) var unsubscribeCalls: [String] = []
    private var subs: [String: ([UInt8]) -> Void] = [:]
    private var disconnectHandlers: [() -> Void] = []
    var connected = true

    init(_ id: String, _ name: String) {
        self.id = id
        self.name = name
    }

    /// waitWritable calls (flow-controlled image packets) and what they return.
    var writableCalls = 0
    var writable = true

    func waitWritable(timeoutMs: Int) async -> Bool {
        writableCalls += 1
        return writable
    }

    func write(_ characteristic: String, _ data: [UInt8], withoutResponse: Bool) async throws {
        if let writeError { throw writeError }
        writes.append(Write(characteristic: characteristic, data: data, withoutResponse: withoutResponse))
        onWrite?(characteristic, data)
    }

    func subscribe(_ characteristic: String, _ onData: @escaping @MainActor ([UInt8]) -> Void) async throws -> @MainActor () -> Void {
        if let error = subscriptionErrors[characteristic] { throw error }
        subs[characteristic] = onData
        return { [weak self] in
            self?.unsubscribeCalls.append(characteristic)
            self?.subs[characteristic] = nil
        }
    }

    func subscribed(_ c: String) -> Bool { subs[c] != nil }

    func has(_ characteristic: String) -> Bool {
        characteristics.contains { $0.caseInsensitiveCompare(characteristic) == .orderedSame }
    }

    func notify(_ c: String, _ data: [UInt8]) { subs[c]?(data) }

    func onDisconnect(_ cb: @escaping @MainActor () -> Void) { disconnectHandlers.append(cb) }

    func disconnect() {
        guard connected else { return }
        connected = false
        disconnectHandlers.forEach { $0() }
    }
}
