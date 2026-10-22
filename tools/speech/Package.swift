// swift-tools-version:5.10
import PackageDescription

// g2speech: streaming on-device speech-to-text over stdin/stdout using Apple's
// Speech framework (SpeechAnalyzer/SpeechTranscriber on macOS 26, SFSpeechRecognizer
// fallback). Info.plist is embedded into the binary so TCC can show a usage string.
let package = Package(
    name: "g2speech",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "g2speech",
            path: "Sources/g2speech",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/g2speech/Info.plist",
                ])
            ]
        )
    ]
)
