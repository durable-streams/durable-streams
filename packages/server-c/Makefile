# Durable Streams Server - Makefile
#
# Ultra high-performance C server for the Durable Streams protocol.

CC = gcc

# Aggressive optimization flags
CFLAGS = -Wall -Wextra -Werror -O3 -march=native -flto -ffast-math
CFLAGS += -funroll-loops -ftree-vectorize -fomit-frame-pointer
CFLAGS += -fprefetch-loop-arrays -fno-stack-protector
CFLAGS += -I./include
CFLAGS += -D_GNU_SOURCE
LDFLAGS = -lmicrohttpd -lpthread -lm -flto -Wl,-O3

# Profile-guided optimization
PGO_GEN_FLAGS = -fprofile-generate
PGO_USE_FLAGS = -fprofile-use -fprofile-correction

# Debug build
DEBUG_CFLAGS = -Wall -Wextra -g -O0 -fsanitize=address,undefined
DEBUG_LDFLAGS = -fsanitize=address,undefined

# Source files
SRCDIR = src
INCDIR = include
OBJDIR = obj

# Use optimized fast versions
SOURCES = $(SRCDIR)/ds_store_fast.c $(SRCDIR)/ds_server_fast.c $(SRCDIR)/ds_fast.c $(SRCDIR)/ds_sse.c $(SRCDIR)/main.c
OBJECTS = $(SOURCES:$(SRCDIR)/%.c=$(OBJDIR)/%.o)

# Target executable
TARGET = durable-streams-server

# Default target
all: $(TARGET)

# Create object directory
$(OBJDIR):
	mkdir -p $(OBJDIR)

# Compile source files
$(OBJDIR)/%.o: $(SRCDIR)/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Link
$(TARGET): $(OBJECTS)
	$(CC) $(OBJECTS) $(LDFLAGS) -o $@

# Debug build
debug: CFLAGS = $(DEBUG_CFLAGS) -I./include -D_GNU_SOURCE
debug: LDFLAGS = $(DEBUG_LDFLAGS) -lmicrohttpd -lpthread -lm
debug: clean $(TARGET)

# Clean
clean:
	rm -rf $(OBJDIR) $(TARGET)

# Install
install: $(TARGET)
	install -d $(DESTDIR)/usr/local/bin
	install -m 755 $(TARGET) $(DESTDIR)/usr/local/bin/

# Run
run: $(TARGET)
	./$(TARGET)

# Run with custom port
run-port: $(TARGET)
	./$(TARGET) -p $(PORT)

# Format code (requires clang-format)
format:
	find $(SRCDIR) $(INCDIR) -name '*.c' -o -name '*.h' | xargs clang-format -i

# Check dependencies
check-deps:
	@which pkg-config > /dev/null || (echo "pkg-config not found" && exit 1)
	@pkg-config --exists libmicrohttpd || (echo "libmicrohttpd not found. Install with: apt install libmicrohttpd-dev" && exit 1)
	@echo "All dependencies found"

# Profile-guided optimization build
pgo-gen: CFLAGS += $(PGO_GEN_FLAGS)
pgo-gen: LDFLAGS += $(PGO_GEN_FLAGS)
pgo-gen: clean $(TARGET)

pgo-use: CFLAGS += $(PGO_USE_FLAGS)
pgo-use: LDFLAGS += $(PGO_USE_FLAGS)
pgo-use: clean $(TARGET)

# Full PGO build: generate profile, run training, build optimized
pgo: pgo-gen
	@echo "Running training workload..."
	./$(TARGET) -p 4439 &
	sleep 1
	@for i in 1 2 3 4 5; do \
		curl -s -X PUT http://localhost:4439/v1/stream/bench-$$i -H "Content-Type: text/plain" -d "test" > /dev/null; \
		for j in 1 2 3 4 5 6 7 8 9 10; do \
			curl -s -X POST http://localhost:4439/v1/stream/bench-$$i -H "Content-Type: text/plain" -d "message $$j" > /dev/null; \
		done; \
		curl -s http://localhost:4439/v1/stream/bench-$$i > /dev/null; \
	done
	pkill -f "$(TARGET) -p 4439" || true
	@echo "Building with PGO..."
	$(MAKE) pgo-use

# Benchmark
bench: $(TARGET)
	@echo "Starting server..."
	./$(TARGET) -p 4440 &
	sleep 1
	@echo "Running benchmark..."
	@echo "=== Create streams ==="
	time for i in $$(seq 1 1000); do curl -s -X PUT http://localhost:4440/v1/stream/bench-$$i -H "Content-Type: text/plain" -d "init" > /dev/null; done
	@echo "=== Append messages ==="
	time for i in $$(seq 1 1000); do curl -s -X POST http://localhost:4440/v1/stream/bench-$$i -H "Content-Type: text/plain" -d "data" > /dev/null; done
	@echo "=== Read streams ==="
	time for i in $$(seq 1 1000); do curl -s http://localhost:4440/v1/stream/bench-$$i > /dev/null; done
	pkill -f "$(TARGET) -p 4440" || true

.PHONY: all clean debug install run run-port format check-deps pgo-gen pgo-use pgo bench
