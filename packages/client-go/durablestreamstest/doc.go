// Package durablestreamstest provides testing utilities for durable streams clients.
//
// # MockServer
//
// MockServer is an in-memory implementation of a Durable Streams server.
// Use it for unit testing without network dependencies:
//
//	func TestAppend(t *testing.T) {
//	    server := durablestreamstest.NewMockServer()
//	    defer server.Close()
//
//	    client := durablestreams.NewClient()
//	    stream := client.Stream(server.URL() + "/test-stream")
//
//	    ctx := context.Background()
//	    err := stream.Create(ctx, durablestreams.WithContentType("text/plain"))
//	    if err != nil {
//	        t.Fatal(err)
//	    }
//
//	    _, err = stream.Append(ctx, []byte("hello"))
//	    if err != nil {
//	        t.Fatal(err)
//	    }
//
//	    // Verify data was stored
//	    data, ok := server.GetStreamData("/test-stream")
//	    if !ok || string(data) != "hello" {
//	        t.Fatal("unexpected data")
//	    }
//	}
//
// # MockTransport
//
// MockTransport is an http.RoundTripper for testing client behavior
// with controlled responses:
//
//	func TestRetry(t *testing.T) {
//	    transport := durablestreamstest.NewMockTransport()
//
//	    // First request fails with 500
//	    transport.AddResponse(&http.Response{
//	        StatusCode: 500,
//	        Body:       io.NopCloser(strings.NewReader("")),
//	    }, nil)
//
//	    // Second request succeeds
//	    transport.AddResponse(&http.Response{
//	        StatusCode: 200,
//	        Header:     http.Header{"Stream-Next-Offset": []string{"5"}},
//	        Body:       io.NopCloser(strings.NewReader("")),
//	    }, nil)
//
//	    client := durablestreams.NewClient(
//	        durablestreams.WithHTTPClient(&http.Client{Transport: transport}),
//	    )
//
//	    // ... test retry behavior
//	}
package durablestreamstest
