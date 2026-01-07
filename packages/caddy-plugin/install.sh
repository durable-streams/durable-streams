#!/bin/sh
set -e

# Durable Streams Server Installer
# Usage: curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
# Or with specific version: curl -sSL ... | sh -s v0.1.0

REPO="durable-streams/durable-streams"
BINARY_NAME="durable-streams-server"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    printf "${GREEN}==>${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}Warning:${NC} %s\n" "$1"
}

error() {
    printf "${RED}Error:${NC} %s\n" "$1"
    exit 1
}

# Detect OS
detect_os() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS" in
        linux) OS="linux" ;;
        darwin) OS="darwin" ;;
        mingw*|msys*|cygwin*) OS="windows" ;;
        *) error "Unsupported operating system: $OS" ;;
    esac
    echo "$OS"
}

# Detect architecture
detect_arch() {
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l) ARCH="armv7" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac
    echo "$ARCH"
}

# Get latest version from GitHub
get_latest_version() {
    if command -v curl >/dev/null 2>&1; then
        VERSION=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"caddy-v([^"]+)".*/\1/')
    elif command -v wget >/dev/null 2>&1; then
        VERSION=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"caddy-v([^"]+)".*/\1/')
    else
        error "curl or wget is required"
    fi

    if [ -z "$VERSION" ]; then
        error "Could not determine latest version"
    fi

    echo "$VERSION"
}

# Download and extract
download_and_extract() {
    local version="$1"
    local os="$2"
    local arch="$3"

    # Remove 'v' prefix if present
    version="${version#v}"

    if [ "$os" = "windows" ]; then
        EXT="zip"
    else
        EXT="tar.gz"
    fi

    FILENAME="${BINARY_NAME}_${version}_${os}_${arch}.${EXT}"
    URL="https://github.com/${REPO}/releases/download/caddy-v${version}/${FILENAME}"

    info "Downloading ${BINARY_NAME} v${version} for ${os}/${arch}..."

    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT

    if command -v curl >/dev/null 2>&1; then
        curl -sL "$URL" -o "${TMP_DIR}/${FILENAME}" || error "Failed to download ${URL}"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$URL" -O "${TMP_DIR}/${FILENAME}" || error "Failed to download ${URL}"
    fi

    info "Extracting..."
    cd "$TMP_DIR"

    if [ "$EXT" = "zip" ]; then
        unzip -q "${FILENAME}" || error "Failed to extract ${FILENAME}"
    else
        tar -xzf "${FILENAME}" || error "Failed to extract ${FILENAME}"
    fi

    echo "$TMP_DIR"
}

# Install binary
install_binary() {
    local tmp_dir="$1"
    local binary="${tmp_dir}/${BINARY_NAME}"

    if [ "$OS" = "windows" ]; then
        binary="${binary}.exe"
    fi

    if [ ! -f "$binary" ]; then
        error "Binary not found after extraction: $binary"
    fi

    # Check if we can write to install dir
    if [ -w "$INSTALL_DIR" ]; then
        info "Installing to ${INSTALL_DIR}/${BINARY_NAME}..."
        mv "$binary" "${INSTALL_DIR}/${BINARY_NAME}"
        chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    else
        info "Installing to ${INSTALL_DIR}/${BINARY_NAME} (requires sudo)..."
        sudo mv "$binary" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    fi
}

# Main installation process
main() {
    info "Durable Streams Server Installer"
    echo ""

    # Get version (use argument or fetch latest)
    if [ -n "$1" ]; then
        VERSION="$1"
        info "Installing version: $VERSION"
    else
        info "Fetching latest version..."
        VERSION=$(get_latest_version)
        info "Latest version: $VERSION"
    fi

    # Detect system
    OS=$(detect_os)
    ARCH=$(detect_arch)
    info "Detected system: ${OS}/${ARCH}"
    echo ""

    # Download and extract
    TMP_DIR=$(download_and_extract "$VERSION" "$OS" "$ARCH")

    # Install
    install_binary "$TMP_DIR"

    # Verify installation
    if command -v "$BINARY_NAME" >/dev/null 2>&1; then
        echo ""
        info "✓ Installation successful!"
        echo ""
        echo "  Run '${BINARY_NAME} --help' to get started"
        echo "  Run '${BINARY_NAME} version' to verify the installation"
        echo ""
    else
        warn "Installation completed, but ${BINARY_NAME} not found in PATH"
        echo "  You may need to add ${INSTALL_DIR} to your PATH"
        echo "  Or run directly: ${INSTALL_DIR}/${BINARY_NAME}"
    fi
}

# Run main with all arguments
main "$@"
