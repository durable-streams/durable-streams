import Testing
@testable import DurableStreams

@Test func testOffsetComparison() async throws {
    let start = Offset.start
    let now = Offset.now
    let custom = Offset(rawValue: "abc123")

    #expect(start.rawValue == "-1")
    #expect(now.rawValue == "now")
    #expect(custom.rawValue == "abc123")
}

@Test func testLiveModeValues() async throws {
    #expect(LiveMode.catchUp.rawValue == "catch-up")
    #expect(LiveMode.longPoll.rawValue == "long-poll")
    #expect(LiveMode.sse.rawValue == "sse")
    #expect(LiveMode.auto.rawValue == "auto")
}
