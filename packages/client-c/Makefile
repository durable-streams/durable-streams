# Durable Streams C Client Makefile

CC ?= gcc
CFLAGS = -Wall -Wextra -std=c11 -O2 -g
CFLAGS += -I./include

# Try to get curl flags from pkg-config or curl-config, fall back to vendored headers and direct linking
CURL_CFLAGS := $(shell pkg-config --cflags libcurl 2>/dev/null || curl-config --cflags 2>/dev/null || echo "-I./vendor")
CURL_LDFLAGS := $(shell pkg-config --libs libcurl 2>/dev/null || curl-config --libs 2>/dev/null || echo "-L/usr/lib/x86_64-linux-gnu -l:libcurl.so.4")
CFLAGS += $(CURL_CFLAGS)
LDFLAGS = $(CURL_LDFLAGS)

# Source files
LIB_SRC = src/durable_streams.c
ADAPTER_SRC = cmd/conformance_adapter.c

# Output
BUILD_DIR = build
LIB_NAME = libdurablestreams
STATIC_LIB = $(BUILD_DIR)/$(LIB_NAME).a
SHARED_LIB = $(BUILD_DIR)/$(LIB_NAME).so
ADAPTER = $(BUILD_DIR)/conformance_adapter

# Objects
LIB_OBJ = $(BUILD_DIR)/durable_streams.o
ADAPTER_OBJ = $(BUILD_DIR)/conformance_adapter.o

.PHONY: all clean test adapter lib

all: $(BUILD_DIR) $(STATIC_LIB) $(ADAPTER)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Library
$(LIB_OBJ): $(LIB_SRC) include/durable_streams.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -fPIC -c $< -o $@

$(STATIC_LIB): $(LIB_OBJ)
	ar rcs $@ $^

$(SHARED_LIB): $(LIB_OBJ)
	$(CC) -shared -o $@ $^ $(LDFLAGS)

lib: $(STATIC_LIB) $(SHARED_LIB)

# Conformance adapter
$(ADAPTER_OBJ): $(ADAPTER_SRC) include/durable_streams.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(ADAPTER): $(ADAPTER_OBJ) $(STATIC_LIB)
	$(CC) -o $@ $< -L$(BUILD_DIR) -ldurablestreams $(LDFLAGS)

adapter: $(ADAPTER)

# Run conformance tests
test: $(ADAPTER)
	@echo "Running conformance tests..."
	@cd ../.. && pnpm test:run -- --client c

# Clean
clean:
	rm -rf $(BUILD_DIR)

# Install (optional)
PREFIX ?= /usr/local
INSTALL_INCLUDE = $(PREFIX)/include
INSTALL_LIB = $(PREFIX)/lib

install: $(STATIC_LIB) $(SHARED_LIB)
	install -d $(INSTALL_INCLUDE)
	install -d $(INSTALL_LIB)
	install -m 644 include/durable_streams.h $(INSTALL_INCLUDE)/
	install -m 644 $(STATIC_LIB) $(INSTALL_LIB)/
	install -m 755 $(SHARED_LIB) $(INSTALL_LIB)/

# Help
help:
	@echo "Durable Streams C Client"
	@echo ""
	@echo "Targets:"
	@echo "  all      - Build library and conformance adapter (default)"
	@echo "  lib      - Build static and shared libraries"
	@echo "  adapter  - Build conformance test adapter"
	@echo "  test     - Run conformance tests"
	@echo "  clean    - Remove build artifacts"
	@echo "  install  - Install library (PREFIX=/usr/local)"
	@echo ""
	@echo "Variables:"
	@echo "  CC       - C compiler (default: gcc)"
	@echo "  CFLAGS   - Additional compiler flags"
	@echo "  PREFIX   - Installation prefix (default: /usr/local)"
