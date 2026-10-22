import Foundation

/// An error from one phase of acquiring a lens ("connect", "discovery", ...), so a failure says where
/// it happened. `G2Central.connect` throws these.
public struct PhaseError: Error, CustomStringConvertible {
    public let phase: String
    public let underlying: Error

    public init(_ phase: String, _ underlying: Error) {
        self.phase = phase
        self.underlying = underlying
    }

    public var description: String { "\(phase): \(describeBleError(underlying))" }
}

/// Short text for an error: Swift errors as `"\(error)"`; NSErrors (CBError, CBATTError) show their
/// message and code, e.g. "Peer removed pairing information (CBError 14)".
public func describeBleError(_ error: Error) -> String {
    if error is CancellationError { return "cancelled" }
    guard type(of: error) is NSError.Type else { return String(describing: error) }
    let ns = error as NSError
    return "\(ns.localizedDescription) (\(ns.domain.replacingOccurrences(of: "ErrorDomain", with: "Error")) \(ns.code))"
}

/// One or both arms failed to connect. Each side carries its own outcome, so the message names the
/// arm and the phase that failed, e.g. "Left: discovery: missing characteristic … · Right: ok".
public struct PairConnectError: Error, CustomStringConvertible {
    public let left: Result<Void, Error>
    public let right: Result<Void, Error>

    public init(left: Result<Void, Error>, right: Result<Void, Error>) {
        self.left = left
        self.right = right
    }

    public func error(_ side: Side) -> Error? {
        if case .failure(let e) = side == .left ? left : right { return e }
        return nil
    }

    public var description: String {
        func text(_ r: Result<Void, Error>) -> String {
            switch r {
            case .success: return "ok"
            case .failure(let e): return describeBleError(e)
            }
        }
        return "Left: \(text(left)) · Right: \(text(right))"
    }
}

/// Acquires both arms as one attempt. Left and right connect (and discover) concurrently, so one
/// arm failing never stops the other from being tried. If either fails, the arm that succeeded is
/// released (a retained arm can stop advertising and disappear from the next scan) and a
/// `PairConnectError` names each arm's outcome. An `attach` failure releases both and is rethrown.
@MainActor
public func connectG2Pair<Peripheral: BlePeripheral, Session>(
    left: () async throws -> Peripheral,
    right: () async throws -> Peripheral,
    attach: (Peripheral, Peripheral) async throws -> Session
) async throws -> Session {
    async let leftResult = capture(left)
    async let rightResult = capture(right)
    let (l, r) = await (leftResult, rightResult)
    var acquired: [Peripheral] = []
    if case .success(let p) = l { acquired.append(p) }
    if case .success(let p) = r { acquired.append(p) }
    do {
        guard case .success(let lp) = l, case .success(let rp) = r else {
            let le = l.map { _ in () }, re = r.map { _ in () }
            if Task.isCancelled || (isCancellation(le) && isCancellation(re)) { throw CancellationError() }
            throw PairConnectError(left: le, right: re)
        }
        try Task.checkCancellation()
        return try await attach(lp, rp)
    } catch {
        for peripheral in acquired.reversed() { peripheral.disconnect() }
        throw error
    }
}

private func capture<P>(_ body: () async throws -> P) async -> Result<P, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}

private func isCancellation(_ r: Result<Void, Error>) -> Bool {
    if case .failure(let e) = r { return e is CancellationError }
    return false
}
