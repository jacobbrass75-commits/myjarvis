import AVFoundation
import CoreLocation
import Foundation

/// Phone GPS for the page's getAppLocation / startAppLocationUpdates.
@MainActor
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiters: [CheckedContinuation<[String: Any]?, Never>] = []
    private var last: CLLocation?
    var onUpdate: (([String: Any]) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    static func json(_ l: CLLocation) -> [String: Any] {
        var j: [String: Any] = [
            "latitude": l.coordinate.latitude, "longitude": l.coordinate.longitude,
            "accuracy": l.horizontalAccuracy, "altitude": l.altitude,
            "timestamp": Int(l.timestamp.timeIntervalSince1970 * 1000),
        ]
        if l.speed >= 0 { j["speed"] = l.speed }
        if l.course >= 0 { j["heading"] = l.course }
        return j
    }

    func currentFix(timeout: Double) async -> [String: Any]? {
        if let l = last, -l.timestamp.timeIntervalSinceNow < 10 { return Self.json(l) }
        manager.requestWhenInUseAuthorization()
        manager.requestLocation()
        return await withCheckedContinuation { c in
            waiters.append(c)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9))
                self?.finish(nil)
            }
        }
    }

    func start(distanceFilter: Double) {
        manager.requestWhenInUseAuthorization()
        manager.distanceFilter = max(1, distanceFilter)
        manager.startUpdatingLocation()
    }

    func stop() { manager.stopUpdatingLocation() }

    private func finish(_ j: [String: Any]?) {
        let ws = waiters
        waiters.removeAll()
        for w in ws { w.resume(returning: j) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        MainActor.assumeIsolated {
            last = l
            let j = Self.json(l)
            finish(j)
            onUpdate?(j)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            log("location: \(error.localizedDescription)")
            finish(nil)
        }
    }
}

/// Phone microphone as 16 kHz s16le mono in 50 ms chunks (same as the glasses stream), used when the
/// page asks for `AudioInputSource.Phone` or no glasses are connected.
@MainActor
final class PhoneMic {
    private let engine = AVAudioEngine()
    private var running = false
    private var starting = false
    private var generation = 0
    private var tapInstalled = false
    private var audioSessionActive = false
    private static weak var owner: PhoneMic?
    private(set) var lastError: String?
    var onPCM: (([UInt8]) -> Void)?

    func start() async -> Bool {
        if running { return true }
        guard !starting else { lastError = "A microphone request is already pending."; return false }
        guard Self.owner == nil || Self.owner === self else {
            lastError = "The microphone is already in use by another Jarvis page. Stop it there first."
            return false
        }
        Self.owner = self // reserve while the system permission prompt is pending
        starting = true
        generation += 1
        let attempt = generation
        lastError = nil
        defer {
            if attempt == generation {
                starting = false
                if !running, Self.owner === self { Self.owner = nil }
            }
        }
        let granted = await AVAudioApplication.requestRecordPermission()
        guard attempt == generation, Self.owner === self else { return false }
        guard granted else { lastError = "Microphone permission was denied. Allow it in iPhone Settings."; return false }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.allowBluetoothHFP, .defaultToSpeaker])
            try session.setActive(true)
            audioSessionActive = true
            let input = engine.inputNode
            let inFormat = input.outputFormat(forBus: 0)
            guard inFormat.sampleRate > 0,
                  let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
                  let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
                lastError = "The phone microphone is unavailable."
                stop()
                return false
            }
            let sink: @Sendable ([[UInt8]]) -> Void = { [weak self] chunks in
                Task { @MainActor in
                    guard let self, self.running, self.generation == attempt else { return }
                    for c in chunks { self.onPCM?(c) }
                }
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: inFormat,
                             block: Self.makeTap(converter: converter, inFormat: inFormat, outFormat: outFormat, sink: sink))
            tapInstalled = true
            engine.prepare()
            try engine.start()
            running = true
            return true
        } catch {
            lastError = "Could not start the phone microphone: \(error.localizedDescription)"
            log("phone mic: \(error.localizedDescription)")
            stop()
            return false
        }
    }

    /// Runs on the audio thread: convert to 16 kHz s16le and cut into 1600-byte (50 ms) chunks.
    private nonisolated static func makeTap(converter: AVAudioConverter, inFormat: AVAudioFormat, outFormat: AVAudioFormat,
                                            sink: @escaping @Sendable ([[UInt8]]) -> Void) -> AVAudioNodeTapBlock {
        final class Pending: @unchecked Sendable { var bytes = [UInt8]() }
        let pending = Pending()
        return { buffer, _ in
            let ratio = outFormat.sampleRate / inFormat.sampleRate
            let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
            final class Fed: @unchecked Sendable { var done = false }
            let fed = Fed()
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in
                if fed.done { status.pointee = .noDataNow; return nil }
                fed.done = true
                status.pointee = .haveData
                return buffer
            }
            guard err == nil, let ch = out.int16ChannelData else { return }
            let n = Int(out.frameLength)
            pending.bytes += UnsafeBufferPointer(start: UnsafeRawPointer(ch[0]).assumingMemoryBound(to: UInt8.self), count: n * 2)
            var chunks: [[UInt8]] = []
            while pending.bytes.count >= 1600 {
                chunks.append(Array(pending.bytes.prefix(1600)))
                pending.bytes.removeFirst(1600)
            }
            if !chunks.isEmpty { sink(chunks) }
        }
    }

    func stop() {
        generation += 1 // also cancels a start waiting for permission
        starting = false
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { engine.stop() }
        running = false
        if Self.owner === self { Self.owner = nil }
        if audioSessionActive {
            audioSessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
