// g2speech — streaming on-device speech-to-text.
//
// stdin:  raw PCM, signed 16-bit little-endian, mono, 16 kHz (override with --rate)
// stdout: newline-delimited JSON, one object per line:
//   {"type":"ready","engine":"analyzer"|"sfspeech","lang":"en-US","onDevice":true}
//   {"type":"partial","text":"...","start":1.2,"end":2.9,"lang":"en-US"}
//   {"type":"final","text":"...","start":1.2,"end":3.4,"lang":"en-US"}
//   {"type":"status","message":"..."}      (asset downloads etc.)
//   {"type":"error","code":"...","message":"..."}   (then exit 2)
//
// Flags:
//   --lang en-US           locale (BCP-47 / Apple identifier, e.g. es-ES, fr-FR, ja-JP)
//   --engine auto|analyzer|sfspeech
//                          analyzer = SpeechAnalyzer/SpeechTranscriber (macOS 26+, no time limit,
//                          no Speech Recognition TCC prompt). sfspeech = SFSpeechRecognizer (needs
//                          Speech Recognition permission; tasks rolled over every <=50 s).
//   --rate 16000           input sample rate
//   --silence 0.6          sfspeech: seconds of silence after speech that end a task (-> "final")
//   --force-finalize 0     analyzer: if >0, force finalize after this much silence. Off by default:
//                          it shaves ~0.4 s but on macOS 26.6 the utterance after a forced
//                          finalize sometimes comes back as punctuation only (",.....").
//   --list-locales         print {"type":"locales",...} and exit
//   --auth-status          print SFSpeechRecognizer authorization status and exit
//   --authorize            request SFSpeechRecognizer authorization (shows the TCC prompt) and exit

import AVFoundation
import CoreMedia
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

// MARK: - output

let outQueue = DispatchQueue(label: "g2speech.out")

func emit(_ obj: [String: Any]) {
    outQueue.sync {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
              let s = String(data: data, encoding: .utf8) else { return }
        print(s)
        fflush(stdout)
    }
}

func logErr(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func round3(_ x: Double) -> NSDecimalNumber { NSDecimalNumber(string: String(format: "%.3f", x.isFinite ? x : 0)) }

struct CLIError: Error { let code: String; let message: String }

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(2)
}

// MARK: - args

var lang = "en-US"
var engine = "auto"
var rate: Double = 16000
var silenceSec: Double = 0.6
var forceFinalizeSec: Double = 0 // 0 = rely on SpeechTranscriber's own endpointing
var mode = "run"
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--lang": lang = it.next() ?? lang
        case "--engine": engine = it.next() ?? engine
        case "--rate": rate = Double(it.next() ?? "") ?? rate
        case "--silence": silenceSec = Double(it.next() ?? "") ?? silenceSec
        case "--force-finalize": forceFinalizeSec = Double(it.next() ?? "") ?? forceFinalizeSec
        case "--list-locales": mode = "list"
        case "--auth-status": mode = "auth-status"
        case "--authorize": mode = "authorize"
        case "-h", "--help":
            print("usage: g2speech [--lang en-US] [--engine auto|analyzer|sfspeech] [--rate 16000] [--silence 0.6] [--force-finalize 0] | --list-locales | --auth-status | --authorize")
            exit(0)
        default: logErr("unknown argument \(a)")
        }
    }
}

// MARK: - stdin

/// Raw stdin chunks, read on a dedicated thread so a blocked read never stalls the analyzer.
func stdinChunks() -> AsyncStream<Data> {
    AsyncStream { cont in
        let t = Thread {
            let fh = FileHandle.standardInput
            while true {
                let d = fh.availableData
                if d.isEmpty { cont.finish(); return }
                cont.yield(d)
            }
        }
        t.start()
    }
}

/// Turns arbitrary byte chunks into whole Int16 samples.
final class SampleAssembler {
    private var carry: UInt8? = nil
    func samples(_ data: Data) -> [Int16] {
        var bytes = [UInt8](data)
        if let c = carry { bytes.insert(c, at: 0); carry = nil }
        if bytes.count % 2 == 1 { carry = bytes.removeLast() }
        var out = [Int16](repeating: 0, count: bytes.count / 2)
        for i in 0..<out.count {
            out[i] = Int16(bitPattern: UInt16(bytes[2 * i]) | (UInt16(bytes[2 * i + 1]) << 8))
        }
        return out
    }
}

/// Energy-based endpointing: reports when speech has been followed by `silenceSec` of quiet.
final class EnergyVAD {
    private var noiseFloor: Double = 0.003
    private var inSpeech = false
    private var heardSpeech = false
    private var silentSamples = 0
    let sampleRate: Double
    let silence: Double
    init(sampleRate: Double, silence: Double) { self.sampleRate = sampleRate; self.silence = silence }

    /// Returns true exactly once per utterance, at the endpoint.
    func feed(_ s: [Int16]) -> Bool {
        guard !s.isEmpty else { return false }
        // Process in 20 ms frames.
        let frame = max(1, Int(sampleRate * 0.02))
        var endpoint = false
        var i = 0
        while i < s.count {
            let j = min(s.count, i + frame)
            var acc = 0.0
            for k in i..<j { let v = Double(s[k]) / 32768.0; acc += v * v }
            let rms = (acc / Double(j - i)).squareRoot()
            let thresh = max(0.008, noiseFloor * 3.0)
            if rms > thresh {
                inSpeech = true; heardSpeech = true; silentSamples = 0
            } else {
                // Track the noise floor slowly upward, quickly downward.
                noiseFloor = rms < noiseFloor ? noiseFloor * 0.9 + rms * 0.1 : noiseFloor * 0.995 + rms * 0.005
                if inSpeech {
                    silentSamples += j - i
                    if Double(silentSamples) / sampleRate >= silence {
                        inSpeech = false
                        endpoint = true
                    }
                }
            }
            i = j
        }
        return endpoint
    }
    var hasHeardSpeech: Bool { heardSpeech }
    func resetHeard() { heardSpeech = inSpeech }
}

let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!

func makeInt16Buffer(_ s: [Int16]) -> AVAudioPCMBuffer? {
    guard let buf = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(s.count)) else { return nil }
    buf.frameLength = AVAudioFrameCount(s.count)
    s.withUnsafeBufferPointer { src in
        buf.int16ChannelData![0].update(from: src.baseAddress!, count: s.count)
    }
    return buf
}

final class Converter {
    let to: AVAudioFormat
    let conv: AVAudioConverter?
    init(to: AVAudioFormat) {
        self.to = to
        conv = (to == inputFormat) ? nil : AVAudioConverter(from: inputFormat, to: to)
    }
    func convert(_ inBuf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let conv else { return inBuf }
        let ratio = to.sampleRate / inputFormat.sampleRate
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return inBuf
        }
        if let err { logErr("convert: \(err)"); return nil }
        return out
    }
}

// MARK: - locales / auth

func authString(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func listLocales() async {
    var obj: [String: Any] = ["type": "locales"]
    let sf = SFSpeechRecognizer.supportedLocales().map { $0.identifier(.bcp47) }.sorted()
    obj["sfspeech"] = sf
    obj["sfspeechOnDevice"] = SFSpeechRecognizer.supportedLocales()
        .filter { SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true }
        .map { $0.identifier(.bcp47) }.sorted()
    obj["sfspeechAuth"] = authString(SFSpeechRecognizer.authorizationStatus())
    if #available(macOS 26.0, *) {
        obj["analyzerAvailable"] = SpeechTranscriber.isAvailable
        obj["analyzer"] = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
        obj["analyzerInstalled"] = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }.sorted()
    } else {
        obj["analyzerAvailable"] = false
        obj["analyzer"] = []
        obj["analyzerInstalled"] = []
    }
    emit(obj)
}

func requestAuth() async -> SFSpeechRecognizerAuthorizationStatus {
    await withCheckedContinuation { c in
        SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
}

// MARK: - engine: SpeechAnalyzer (macOS 26)

@available(macOS 26.0, *)
func analyzerLocale(_ lang: String) async -> Locale? {
    guard SpeechTranscriber.isAvailable else { return nil }
    return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang))
}

@available(macOS 26.0, *)
func runAnalyzer(locale: Locale, chunks: AsyncStream<Data>) async throws {
    let tag = locale.identifier(.bcp47)
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange])

    let status = await AssetInventory.status(forModules: [transcriber])
    if status != .installed {
        emit(["type": "status", "message": "installing on-device speech model for \(tag)"])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await req.downloadAndInstall()
        }
        emit(["type": "status", "message": "speech model for \(tag) installed"])
    }
    _ = try? await AssetInventory.reserve(locale: locale)

    guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: inputFormat) else {
        throw CLIError(code: "no_format", message: "no compatible audio format")
    }
    let converter = Converter(to: fmt)
    let (inputSeq, inputCont) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.prepareToAnalyze(in: fmt)

    let resultsTask = Task {
        for try await r in transcriber.results {
            let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty && !r.isFinal { continue }
            if text.isEmpty { continue }
            emit([
                "type": r.isFinal ? "final" : "partial",
                "text": text,
                "start": round3(r.range.start.seconds),
                "end": round3(CMTimeRangeGetEnd(r.range).seconds),
                "lang": tag,
            ])
        }
    }
    try await analyzer.start(inputSequence: inputSeq)
    emit(["type": "ready", "engine": "analyzer", "lang": tag, "onDevice": true, "format": "\(fmt.sampleRate)Hz/\(fmt.commonFormat.rawValue)"])

    let asm = SampleAssembler()
    let vad = EnergyVAD(sampleRate: rate, silence: forceFinalizeSec > 0 ? forceFinalizeSec : 1e9)
    var total: Int64 = 0
    for await data in chunks {
        let s = asm.samples(data)
        if s.isEmpty { continue }
        guard let ib = makeInt16Buffer(s), let ob = converter.convert(ib) else { continue }
        inputCont.yield(AnalyzerInput(buffer: ob))
        total += Int64(s.count)
        if forceFinalizeSec > 0 && vad.feed(s) {
            // Speech followed by silence: force the pending words to finalize now
            // instead of waiting for the model's own (slower) endpointing.
            let through = CMTime(value: total, timescale: CMTimeScale(rate))
            Task { try? await analyzer.finalize(through: through) }
        }
    }
    inputCont.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    try await resultsTask.value
}

// MARK: - engine: SFSpeechRecognizer (rolling tasks)

final class SFRoller {
    let recognizer: SFSpeechRecognizer
    let onDevice: Bool
    let tag: String
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var sessionStartSample: Int64 = 0
    private var sessionSamples: Int64 = 0
    private var pending = 0
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    let maxSessionSec: Double = 50 // Apple limits a task to ~60 s of audio

    init(recognizer: SFSpeechRecognizer, onDevice: Bool, tag: String) {
        self.recognizer = recognizer; self.onDevice = onDevice; self.tag = tag
    }

    private func startSession(at sample: Int64) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = onDevice
        req.addsPunctuation = true
        req.taskHint = .dictation
        let offset = Double(sample) / rate
        lock.lock(); pending += 1; lock.unlock()
        var finished = false
        let finish = { [weak self] in
            guard let self, !finished else { return }
            finished = true
            self.lock.lock(); self.pending -= 1; let p = self.pending; self.lock.unlock()
            if p == 0 { self.done.signal() }
        }
        task = recognizer.recognitionTask(with: req) { [tag] result, error in
            if let result {
                let t = result.bestTranscription
                let text = t.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    let segs = t.segments
                    let start = offset + (segs.first?.timestamp ?? 0)
                    let end = offset + ((segs.last.map { $0.timestamp + $0.duration }) ?? 0)
                    emit(["type": result.isFinal ? "final" : "partial", "text": text,
                          "start": round3(start), "end": round3(max(end, start)), "lang": tag])
                }
                if result.isFinal { finish() }
            }
            if let error {
                let ns = error as NSError
                // 1110 = no speech detected, 301/216 = cancelled: expected when rolling over.
                if ![1110, 301, 216, 203].contains(ns.code) { logErr("sfspeech: \(ns.domain) \(ns.code) \(ns.localizedDescription)") }
                finish()
            }
        }
        request = req
        sessionStartSample = sample
        sessionSamples = 0
    }

    /// End the current task (it will deliver its final) and immediately start a new one.
    private func roll(at sample: Int64) {
        request?.endAudio()
        startSession(at: sample)
    }

    func run(chunks: AsyncStream<Data>) async {
        let asm = SampleAssembler()
        let vad = EnergyVAD(sampleRate: rate, silence: silenceSec)
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let conv = Converter(to: fmt)
        var total: Int64 = 0
        startSession(at: 0)
        emit(["type": "ready", "engine": "sfspeech", "lang": tag, "onDevice": onDevice])
        for await data in chunks {
            let s = asm.samples(data)
            if s.isEmpty { continue }
            guard let ib = makeInt16Buffer(s), let ob = conv.convert(ib) else { continue }
            request?.append(ob)
            total += Int64(s.count)
            sessionSamples += Int64(s.count)
            let endpoint = vad.feed(s)
            let age = Double(sessionSamples) / rate
            if endpoint && vad.hasHeardSpeech {
                vad.resetHeard()
                roll(at: total)
            } else if age >= maxSessionSec {
                roll(at: total)
            }
        }
        request?.endAudio()
        request = nil
        // Wait (bounded) for outstanding tasks to deliver their finals.
        let sem = done
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async { _ = sem.wait(timeout: .now() + 10); c.resume() }
        }
    }
}

func runSFSpeech(lang: String, chunks: AsyncStream<Data>) async throws {
    var st = SFSpeechRecognizer.authorizationStatus()
    if st == .notDetermined { st = await requestAuth() }
    guard st == .authorized else {
        throw CLIError(code: "not_authorized",
                       message: "Speech Recognition permission is \(authString(st)). Run `g2speech --authorize` from Terminal and allow it, or enable it in System Settings > Privacy & Security > Speech Recognition.")
    }
    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
        throw CLIError(code: "unsupported_locale", message: "SFSpeechRecognizer does not support \(lang)")
    }
    let onDevice = rec.supportsOnDeviceRecognition
    if !onDevice { emit(["type": "status", "message": "on-device recognition unavailable for \(lang); Apple servers will be used"]) }
    let roller = SFRoller(recognizer: rec, onDevice: onDevice, tag: rec.locale.identifier(.bcp47))
    await roller.run(chunks: chunks)
    withExtendedLifetime(roller) {}
}

// MARK: - TCC responsibility

/// TCC attributes a CLI's privacy requests to its *responsible* process (Terminal, the node hub,
/// the Claude app...), and aborts if that app has no NSSpeechRecognitionUsageDescription. Re-exec
/// ourselves with responsibility disclaimed so TCC uses g2speech's own embedded Info.plist and
/// remembers the grant for g2speech itself, no matter who launched it. stdin/stdout are inherited.
func reexecDisclaimedIfNeeded() {
    if ProcessInfo.processInfo.environment["G2SPEECH_DISCLAIMED"] == "1" { return }
    typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
        logErr("responsibility_spawnattrs_setdisclaim unavailable; TCC will use the parent app")
        return
    }
    let disclaim = unsafeBitCast(sym, to: DisclaimFn.self)
    var attr: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    _ = disclaim(&attr, 1)
    let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var env = ProcessInfo.processInfo.environment
    env["G2SPEECH_DISCLAIMED"] = "1"
    let argv: [UnsafeMutablePointer<CChar>?] = ([exe] + CommandLine.arguments.dropFirst()).map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, exe, nil, &attr, argv, envp)
    guard rc == 0 else { logErr("posix_spawn failed: \(rc)"); return }
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { kill(pid, sig) }
        src.resume()
        signalSources.append(src)
    }
    DispatchQueue.global().async {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        exit(code)
    }
    while true { pause() }
}
var signalSources: [DispatchSourceSignal] = []

// MARK: - main

let mainTask = Task {
    switch mode {
    case "list":
        reexecDisclaimedIfNeeded()
        await listLocales(); exit(0)
    case "auth-status":
        reexecDisclaimedIfNeeded()
        emit(["type": "auth", "status": authString(SFSpeechRecognizer.authorizationStatus())]); exit(0)
    case "authorize":
        reexecDisclaimedIfNeeded()
        let st = await requestAuth()
        emit(["type": "auth", "status": authString(st)]); exit(st == .authorized ? 0 : 1)
    default: break
    }

    do {
        var useAnalyzer = false
        var aLocale: Locale? = nil
        if engine == "auto" || engine == "analyzer" {
            if #available(macOS 26.0, *) {
                aLocale = await analyzerLocale(lang)
                useAnalyzer = aLocale != nil
            }
            if !useAnalyzer && engine == "analyzer" {
                throw CLIError(code: "unsupported_locale", message: "SpeechTranscriber unavailable or does not support \(lang)")
            }
        }
        if !useAnalyzer { reexecDisclaimedIfNeeded() }
        let chunks = stdinChunks()
        if useAnalyzer, #available(macOS 26.0, *), let aLocale {
            try await runAnalyzer(locale: aLocale, chunks: chunks)
        } else {
            try await runSFSpeech(lang: lang, chunks: chunks)
        }
        emit(["type": "end"])
        exit(0)
    } catch let e as CLIError {
        fail(e.code, e.message)
    } catch {
        fail("engine_error", "\(error)")
    }
}

dispatchMain()
