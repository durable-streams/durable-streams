// swift-tools-version: 6.0
// Root Package.swift for SwiftPM Git dependencies
// Actual implementation is in packages/client-swift/

import PackageDescription

let package = Package(
    name: "DurableStreams",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .tvOS(.v16),
        .watchOS(.v9),
    ],
    products: [
        .library(
            name: "DurableStreams",
            targets: ["DurableStreams"]),
    ],
    targets: [
        .target(
            name: "DurableStreams",
            path: "packages/client-swift/Sources/DurableStreams"),
    ]
)
