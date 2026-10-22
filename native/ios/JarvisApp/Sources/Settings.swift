import Foundation
import G2Kit
import os
import Security

/// Hub URL and options in UserDefaults; the hub token in the Keychain.
@MainActor
final class AppSettings: ObservableObject {
    private let d = UserDefaults.standard

    @Published var hubURL: String { didSet { d.set(hubURL, forKey: "hubURL") } }
    @Published var token: String { didSet { Keychain.set(token, for: "hubToken") } }
    /// Use the phone mic when the page asks for audio and no glasses are connected.
    @Published var phoneMicFallback: Bool { didSet { d.set(phoneMicFallback, forKey: "phoneMicFallback") } }
    /// PIPE_ROLE_CHANGE value: 1 per MentraOS (default), 2 per the Even App capture.
    @Published var pipeRole: Int { didSet { d.set(pipeRole, forKey: "pipeRole") } }
    /// Send the dashboard prelude the Even App sends at start-up (try if pages never appear).
    @Published var dashboardPrelude: Bool { didSet { d.set(dashboardPrelude, forKey: "dashboardPrelude") } }
    /// Reconnect to the last glasses automatically.
    @Published var autoConnect: Bool { didSet { d.set(autoConnect, forKey: "autoConnect") } }
    /// Send onboarding skip (0x10) and gesture_ctrl init (0x0D) after TIME_SYNC, as the drivers that
    /// receive ring events do (DriverOptions.sessionInit).
    @Published var sessionInit: Bool { didSet { d.set(sessionInit, forKey: "sessionInit") } }
    /// Image packets with flow control and 2 fragments in flight (DriverOptions.imageFlowControl /
    /// imageWindow). Off = MentraOS pacing: 6 ms between packets, one fragment per ACK.
    @Published var fastImages: Bool { didSet { d.set(fastImages, forKey: "fastImages") } }
    /// Image payload (G2Kit ImageFormat raw value). Anything but "standard" is an experiment; the driver
    /// falls back to standard for the session if the glasses refuse it. `-imageFormat lz4` as a launch
    /// argument overrides it for that launch. Applies to the next image.
    @Published var imageFormat: String { didSet { d.set(imageFormat, forKey: "imageFormat") } }

    init() {
        hubURL = d.string(forKey: "hubURL") ?? "http://192.168.1.2:8787"
        // `-hubToken …` as a launch argument (simulator/dev builds) overrides and saves the token.
        if let t = d.string(forKey: "hubToken"), !t.isEmpty {
            token = t
            Keychain.set(t, for: "hubToken")
        } else {
            token = Keychain.get("hubToken") ?? ""
        }
        phoneMicFallback = d.object(forKey: "phoneMicFallback") as? Bool ?? true
        pipeRole = d.object(forKey: "pipeRole") as? Int ?? 1
        dashboardPrelude = d.bool(forKey: "dashboardPrelude")
        autoConnect = d.object(forKey: "autoConnect") as? Bool ?? true
        sessionInit = d.object(forKey: "sessionInit") as? Bool ?? true
        fastImages = d.object(forKey: "fastImages") as? Bool ?? true
        imageFormat = d.string(forKey: "imageFormat").flatMap { ImageFormat(rawValue: $0)?.rawValue } ?? ImageFormat.standard.rawValue
        // Persist a launch-argument URL for ordinary app launches.
        d.set(hubURL, forKey: "hubURL")
    }

    /// The glasses web app as served by the hub (`glasses/dist` at /glasses/).
    var glassesPageURL: URL? {
        var s = hubURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s + "/glasses/")
    }

    // Storage for the page's get/setLocalStorage (the Even App keeps this per app).
    func pageValue(_ key: String) -> String {
        if key == "hubToken" { return token }
        return d.string(forKey: "page." + key) ?? ""
    }

    func setPageValue(_ key: String, _ value: String) {
        if key == "hubToken" {
            if token != value { token = value }
            return
        }
        d.set(value, forKey: "page." + key)
    }
}

enum Keychain {
    private static let service = "JarvisG2"

    static func get(_ account: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// In-app log shown on the Log tab. Every line also goes to `Documents/jarvis.log` (pull it with
/// `xcrun devicectl device copy from … --domain-type appDataContainer --domain-identifier
/// com.myjarvis.JarvisG2 --source Documents/jarvis.log`, or the Files app / Log tab share button) and to
/// the unified log (subsystem com.myjarvis.JarvisG2, category ble) so Console.app can stream it.
@MainActor
final class AppLog: ObservableObject {
    static let shared = AppLog()
    @Published private(set) var lines: [String] = []
    /// Documents/jarvis.log (the previous 5 MB lives in jarvis-previous.log).
    nonisolated static let fileURL: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("jarvis.log")
    private let file = LogFile(url: AppLog.fileURL)
    private let osLog = Logger(subsystem: "com.myjarvis.JarvisG2", category: "ble")
    private let fmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
    private let fileFmt: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    private init() {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        file.append("---- \(fileFmt.string(from: Date())) Jarvis G2 \(v) (\(b)) log opened ----")
    }

    func add(_ s: String) {
        let now = Date()
        let line = "\(fmt.string(from: now)) \(s)"
        print("[jarvis] \(s)")
        osLog.log("\(s, privacy: .public)")
        file.append("\(fileFmt.string(from: now)) \(s)")
        lines.append(line)
        if lines.count > 1000 { lines.removeFirst(lines.count - 1000) }
    }

    func clear() { lines.removeAll() }
}

/// Append-only log file written on its own queue. Each line is written straight to the file
/// descriptor (FileHandle does not buffer), so a line is in the file as soon as its write runs and
/// survives the app being killed right after. Rotates to jarvis-previous.log at 5 MB.
final class LogFile: @unchecked Sendable {
    static let maxBytes = 5 * 1024 * 1024
    let url: URL
    private let queue = DispatchQueue(label: "com.myjarvis.JarvisG2.logfile", qos: .utility)
    private var handle: FileHandle?
    private var size = 0

    init(url: URL) { self.url = url }

    var previousURL: URL { url.deletingLastPathComponent().appendingPathComponent("jarvis-previous.log") }

    func append(_ line: String) {
        queue.async { self.write(Data((line + "\n").utf8)) }
    }

    private func write(_ data: Data) {
        if handle == nil { open() }
        if size > 0, size + data.count > Self.maxBytes { rotate() }
        guard let handle else { return }
        do {
            try handle.write(contentsOf: data)
            size += data.count
        } catch {
            try? handle.close()
            self.handle = nil
        }
    }

    private func open() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        guard let h = try? FileHandle(forWritingTo: url) else { return }
        size = Int((try? h.seekToEnd()) ?? 0)
        handle = h
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        let fm = FileManager.default
        try? fm.removeItem(at: previousURL)
        try? fm.moveItem(at: url, to: previousURL)
        open()
    }
}

@MainActor
func log(_ s: String) { AppLog.shared.add(s) }
