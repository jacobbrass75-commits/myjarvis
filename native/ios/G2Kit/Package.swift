// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "G2Kit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "G2Kit", targets: ["G2Kit"]),
    ],
    targets: [
        // Google's reference LC3 codec (Apache-2.0), vendored unmodified. See Sources/CLiblc3/README.md.
        .target(
            name: "CLiblc3",
            exclude: ["LICENSE", "README.md"]
        ),
        .target(name: "G2Kit", dependencies: ["CLiblc3"]),
        .testTarget(name: "G2KitTests", dependencies: ["G2Kit"]),
    ],
    swiftLanguageModes: [.v5]
)
