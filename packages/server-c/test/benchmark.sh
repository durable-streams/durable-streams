#!/bin/bash
# Performance benchmark for Durable Streams C Server

SERVER_URL="${1:-http://localhost:4438}"
NUM_STREAMS="${2:-1000}"
NUM_APPENDS="${3:-10}"

echo "==================================="
echo "Durable Streams C Server Benchmark"
echo "==================================="
echo "Server: $SERVER_URL"
echo "Streams: $NUM_STREAMS"
echo "Appends per stream: $NUM_APPENDS"
echo ""

# Warmup
echo "Warming up..."
for i in $(seq 1 10); do
    curl -s -X PUT "$SERVER_URL/v1/stream/warmup-$i" -H "Content-Type: text/plain" -d "warmup" > /dev/null
    curl -s -X POST "$SERVER_URL/v1/stream/warmup-$i" -H "Content-Type: text/plain" -d "data" > /dev/null
    curl -s "$SERVER_URL/v1/stream/warmup-$i" > /dev/null
    curl -s -X DELETE "$SERVER_URL/v1/stream/warmup-$i" > /dev/null
done

echo ""
echo "=== CREATE STREAMS ==="
start_time=$(date +%s.%N)
for i in $(seq 1 $NUM_STREAMS); do
    curl -s -X PUT "$SERVER_URL/v1/stream/bench-$i" -H "Content-Type: text/plain" -d "initial" > /dev/null
done
end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)
rate=$(echo "scale=2; $NUM_STREAMS / $duration" | bc)
echo "Created $NUM_STREAMS streams in ${duration}s ($rate streams/sec)"

echo ""
echo "=== APPEND TO STREAMS ==="
total_appends=$((NUM_STREAMS * NUM_APPENDS))
start_time=$(date +%s.%N)
for i in $(seq 1 $NUM_STREAMS); do
    for j in $(seq 1 $NUM_APPENDS); do
        curl -s -X POST "$SERVER_URL/v1/stream/bench-$i" -H "Content-Type: text/plain" -d "message $j for stream $i with extra padding to make it more realistic" > /dev/null
    done
done
end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)
rate=$(echo "scale=2; $total_appends / $duration" | bc)
echo "Appended $total_appends messages in ${duration}s ($rate msg/sec)"

echo ""
echo "=== READ STREAMS ==="
start_time=$(date +%s.%N)
for i in $(seq 1 $NUM_STREAMS); do
    curl -s "$SERVER_URL/v1/stream/bench-$i" > /dev/null
done
end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)
rate=$(echo "scale=2; $NUM_STREAMS / $duration" | bc)
echo "Read $NUM_STREAMS streams in ${duration}s ($rate reads/sec)"

echo ""
echo "=== CLEANUP ==="
start_time=$(date +%s.%N)
for i in $(seq 1 $NUM_STREAMS); do
    curl -s -X DELETE "$SERVER_URL/v1/stream/bench-$i" > /dev/null
done
end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)
rate=$(echo "scale=2; $NUM_STREAMS / $duration" | bc)
echo "Deleted $NUM_STREAMS streams in ${duration}s ($rate deletes/sec)"

echo ""
echo "==================================="
echo "Benchmark complete!"
echo "==================================="
