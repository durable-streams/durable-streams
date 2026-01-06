# Makefile for Durable Streams Fortran Client
#
# Usage:
#   make          - Build library and examples
#   make lib      - Build library only
#   make examples - Build examples
#   make test     - Build and run tests
#   make clean    - Clean build artifacts
#
# Requirements:
#   - gfortran (GNU Fortran compiler)
#   - libcurl development files

# Compiler settings
FC = gfortran
FFLAGS = -std=f2008 -Wall -Wextra -fPIC
LDFLAGS = -lcurl

# Directories
SRCDIR = src
LIBDIR = lib
MODDIR = mod
BINDIR = bin
EXDIR = examples
TESTDIR = test

# Library name
LIBNAME = libdurable_streams.a

# Source files (in dependency order - important!)
SOURCES = \
	$(SRCDIR)/ds_constants.f90 \
	$(SRCDIR)/ds_errors.f90 \
	$(SRCDIR)/ds_curl.f90 \
	$(SRCDIR)/ds_json.f90 \
	$(SRCDIR)/ds_types.f90 \
	$(SRCDIR)/ds_http.f90 \
	$(SRCDIR)/durable_streams.f90

# Object files
OBJECTS = $(SOURCES:.f90=.o)

# Example programs
EXAMPLES = basic_usage live_read json_example

# Default target
all: lib examples

# Create directories
$(LIBDIR) $(MODDIR) $(BINDIR):
	mkdir -p $@

# Library target
lib: $(LIBDIR) $(MODDIR) $(LIBDIR)/$(LIBNAME)

$(LIBDIR)/$(LIBNAME): $(OBJECTS)
	ar rcs $@ $^
	@echo "Library built: $@"

# Compile source files
$(SRCDIR)/%.o: $(SRCDIR)/%.f90 | $(MODDIR)
	$(FC) $(FFLAGS) -J$(MODDIR) -c $< -o $@

# Examples target
examples: lib $(BINDIR) $(addprefix $(BINDIR)/,$(EXAMPLES))

$(BINDIR)/basic_usage: $(EXDIR)/basic_usage.f90 $(LIBDIR)/$(LIBNAME)
	$(FC) $(FFLAGS) -I$(MODDIR) $< -L$(LIBDIR) -ldurable_streams $(LDFLAGS) -o $@

$(BINDIR)/live_read: $(EXDIR)/live_read.f90 $(LIBDIR)/$(LIBNAME)
	$(FC) $(FFLAGS) -I$(MODDIR) $< -L$(LIBDIR) -ldurable_streams $(LDFLAGS) -o $@

$(BINDIR)/json_example: $(EXDIR)/json_example.f90 $(LIBDIR)/$(LIBNAME)
	$(FC) $(FFLAGS) -I$(MODDIR) $< -L$(LIBDIR) -ldurable_streams $(LDFLAGS) -o $@

# Test target
test: lib $(BINDIR)
	$(FC) $(FFLAGS) -I$(MODDIR) $(TESTDIR)/test_stream.f90 -L$(LIBDIR) -ldurable_streams $(LDFLAGS) -o $(BINDIR)/test_stream
	@echo ""
	@echo "Running tests..."
	@echo ""
	@$(BINDIR)/test_stream

# Clean target
clean:
	rm -f $(SRCDIR)/*.o
	rm -f $(MODDIR)/*.mod
	rm -f $(LIBDIR)/$(LIBNAME)
	rm -f $(BINDIR)/*

# Very clean - remove directories too
distclean: clean
	rm -rf $(LIBDIR) $(MODDIR) $(BINDIR)

# Dependencies (module dependencies)
$(SRCDIR)/ds_errors.o: $(SRCDIR)/ds_constants.o
$(SRCDIR)/ds_curl.o: $(SRCDIR)/ds_constants.o
$(SRCDIR)/ds_json.o: $(SRCDIR)/ds_constants.o
$(SRCDIR)/ds_types.o: $(SRCDIR)/ds_constants.o
$(SRCDIR)/ds_http.o: $(SRCDIR)/ds_constants.o $(SRCDIR)/ds_errors.o $(SRCDIR)/ds_curl.o
$(SRCDIR)/durable_streams.o: $(SRCDIR)/ds_constants.o $(SRCDIR)/ds_errors.o $(SRCDIR)/ds_types.o $(SRCDIR)/ds_json.o $(SRCDIR)/ds_http.o

.PHONY: all lib examples test clean distclean
