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

@Test func testLiveModeQueryValues() async throws {
    // LiveMode uses queryValue (not rawValue) for URL parameters
    #expect(LiveMode.catchUp.queryValue == nil)  // catchUp omits the parameter
    #expect(LiveMode.longPoll.queryValue == "long-poll")
    #expect(LiveMode.sse.queryValue == "sse")
    #expect(LiveMode.auto.queryValue == "long-poll")  // auto defaults to long-poll
}
