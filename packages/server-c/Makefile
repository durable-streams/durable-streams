# Durable Streams Server - Makefile
#
# High-performance C server for the Durable Streams protocol.

CC = gcc
CFLAGS = -Wall -Wextra -Werror -O3 -march=native -flto -ffast-math
CFLAGS += -I./include
CFLAGS += -D_GNU_SOURCE
LDFLAGS = -lmicrohttpd -lpthread -lm -flto

# Debug build
DEBUG_CFLAGS = -Wall -Wextra -g -O0 -fsanitize=address,undefined
DEBUG_LDFLAGS = -fsanitize=address,undefined

# Source files
SRCDIR = src
INCDIR = include
OBJDIR = obj

SOURCES = $(SRCDIR)/ds_store.c $(SRCDIR)/ds_server.c $(SRCDIR)/ds_sse.c $(SRCDIR)/main.c
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

.PHONY: all clean debug install run run-port format check-deps
