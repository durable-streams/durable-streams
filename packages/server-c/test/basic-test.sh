#!/bin/bash
# Basic conformance test script for the C server

# Don't exit on error - we want to run all tests
# set -e

BASE_URL="${1:-http://localhost:4438}"
PASSED=0
FAILED=0

echo "Testing Durable Streams C Server at $BASE_URL"
echo "=============================================="

test_pass() {
    echo "PASS: $1"
    ((PASSED++))
}

test_fail() {
    echo "FAIL: $1 - $2"
    ((FAILED++))
}

# Generate unique stream path
STREAM_PATH="/v1/stream/test-$(date +%s)-$RANDOM"

echo ""
echo "=== Basic Stream Operations ==="

# Test 1: Create stream
echo "Test: Create stream (PUT)"
STATUS=$(curl -s -X PUT "$BASE_URL$STREAM_PATH" -H "Content-Type: text/plain" -d "hello" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "201" ]; then
    test_pass "Create stream returned 201"
else
    test_fail "Create stream" "Expected 201, got $STATUS"
fi

# Test 2: Idempotent create
echo "Test: Idempotent create (same config)"
STATUS=$(curl -s -X PUT "$BASE_URL$STREAM_PATH" -H "Content-Type: text/plain" -d "" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
    test_pass "Idempotent create returned $STATUS"
else
    test_fail "Idempotent create" "Expected 200 or 201, got $STATUS"
fi

# Test 3: Append data
echo "Test: Append data (POST)"
STATUS=$(curl -s -X POST "$BASE_URL$STREAM_PATH" -H "Content-Type: text/plain" -d " world" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "204" ]; then
    test_pass "Append returned 204"
else
    test_fail "Append" "Expected 204, got $STATUS"
fi

# Test 4: Read data
echo "Test: Read data (GET)"
RESPONSE=$(curl -s "$BASE_URL$STREAM_PATH")
if [ "$RESPONSE" = "hello world" ]; then
    test_pass "Read returned 'hello world'"
else
    test_fail "Read" "Expected 'hello world', got '$RESPONSE'"
fi

# Test 5: HEAD request
echo "Test: HEAD request"
STATUS=$(curl -s -I "$BASE_URL$STREAM_PATH" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "200" ]; then
    test_pass "HEAD returned 200"
else
    test_fail "HEAD" "Expected 200, got $STATUS"
fi

# Test 6: Stream-Next-Offset header
echo "Test: Stream-Next-Offset header on GET"
OFFSET=$(curl -s -I "$BASE_URL$STREAM_PATH" | grep -i "Stream-Next-Offset" | cut -d: -f2 | tr -d ' \r\n')
if [ -n "$OFFSET" ]; then
    test_pass "Stream-Next-Offset present: $OFFSET"
else
    test_fail "Stream-Next-Offset" "Header not found"
fi

# Test 7: Read from offset
echo "Test: Read from offset"
RESPONSE=$(curl -s "$BASE_URL$STREAM_PATH?offset=$OFFSET")
if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ]; then
    test_pass "Read from tail returned empty"
else
    test_fail "Read from tail" "Expected empty, got '$RESPONSE'"
fi

# Test 8: Delete stream
echo "Test: Delete stream"
STATUS=$(curl -s -X DELETE "$BASE_URL$STREAM_PATH" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "204" ]; then
    test_pass "Delete returned 204"
else
    test_fail "Delete" "Expected 204, got $STATUS"
fi

# Test 9: 404 after delete
echo "Test: 404 after delete"
STATUS=$(curl -s "$BASE_URL$STREAM_PATH" -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "404" ]; then
    test_pass "GET after delete returned 404"
else
    test_fail "GET after delete" "Expected 404, got $STATUS"
fi

# Test 10: JSON mode
echo ""
echo "=== JSON Mode ==="
JSON_PATH="/v1/stream/json-test-$(date +%s)-$RANDOM"

echo "Test: Create JSON stream"
STATUS=$(curl -s -X PUT "$BASE_URL$JSON_PATH" -H "Content-Type: application/json" -d '[1,2,3]' -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "201" ]; then
    test_pass "Create JSON stream returned 201"
else
    test_fail "Create JSON stream" "Expected 201, got $STATUS"
fi

echo "Test: Read JSON stream"
RESPONSE=$(curl -s "$BASE_URL$JSON_PATH")
if [ "$RESPONSE" = "[1,2,3]" ]; then
    test_pass "JSON read returned [1,2,3]"
else
    test_fail "JSON read" "Expected [1,2,3], got '$RESPONSE'"
fi

echo "Test: Append to JSON stream"
STATUS=$(curl -s -X POST "$BASE_URL$JSON_PATH" -H "Content-Type: application/json" -d '{"key":"value"}' -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "204" ]; then
    test_pass "JSON append returned 204"
else
    test_fail "JSON append" "Expected 204, got $STATUS"
fi

echo "Test: Read concatenated JSON"
RESPONSE=$(curl -s "$BASE_URL$JSON_PATH")
if [ "$RESPONSE" = '[1,2,3,{"key":"value"}]' ]; then
    test_pass "JSON concatenation correct"
else
    test_fail "JSON concatenation" "Expected '[1,2,3,{\"key\":\"value\"}]', got '$RESPONSE'"
fi

# Cleanup
curl -s -X DELETE "$BASE_URL$JSON_PATH" > /dev/null

# Test 11: Idempotent producer
echo ""
echo "=== Idempotent Producer ==="
PROD_PATH="/v1/stream/producer-test-$(date +%s)-$RANDOM"

echo "Test: Create stream for producer test"
curl -s -X PUT "$BASE_URL$PROD_PATH" -H "Content-Type: text/plain" > /dev/null

echo "Test: First producer append (epoch=0, seq=0)"
STATUS=$(curl -s -X POST "$BASE_URL$PROD_PATH" \
    -H "Content-Type: text/plain" \
    -H "Producer-Id: test-producer" \
    -H "Producer-Epoch: 0" \
    -H "Producer-Seq: 0" \
    -d "message1" \
    -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "200" ]; then
    test_pass "First producer append returned 200"
else
    test_fail "First producer append" "Expected 200, got $STATUS"
fi

echo "Test: Duplicate producer append (should return 204)"
STATUS=$(curl -s -X POST "$BASE_URL$PROD_PATH" \
    -H "Content-Type: text/plain" \
    -H "Producer-Id: test-producer" \
    -H "Producer-Epoch: 0" \
    -H "Producer-Seq: 0" \
    -d "message1" \
    -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "204" ]; then
    test_pass "Duplicate append returned 204"
else
    test_fail "Duplicate append" "Expected 204, got $STATUS"
fi

echo "Test: Sequence increment (seq=1)"
STATUS=$(curl -s -X POST "$BASE_URL$PROD_PATH" \
    -H "Content-Type: text/plain" \
    -H "Producer-Id: test-producer" \
    -H "Producer-Epoch: 0" \
    -H "Producer-Seq: 1" \
    -d "message2" \
    -o /dev/null -w "%{http_code}")
if [ "$STATUS" = "200" ]; then
    test_pass "Sequence increment returned 200"
else
    test_fail "Sequence increment" "Expected 200, got $STATUS"
fi

# Cleanup
curl -s -X DELETE "$BASE_URL$PROD_PATH" > /dev/null

echo ""
echo "=============================================="
echo "Results: $PASSED passed, $FAILED failed"
echo "=============================================="

if [ $FAILED -eq 0 ]; then
    echo "All tests passed!"
    exit 0
else
    echo "Some tests failed."
    exit 1
fi
