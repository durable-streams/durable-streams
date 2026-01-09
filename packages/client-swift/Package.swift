// swift-tools-version: 6.0
// The swift-tools-version declares the minimum version of Swift required to build this package.

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
        .executable(
            name: "conformance-adapter",
            targets: ["ConformanceAdapter"]),
    ],
    targets: [
        .target(
            name: "DurableStreams"),
        .executableTarget(
            name: "ConformanceAdapter",
            dependencies: ["DurableStreams"]),
        .testTarget(
            name: "DurableStreamsTests",
            dependencies: ["DurableStreams"]),
    ]
)
