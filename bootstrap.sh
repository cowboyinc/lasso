#!/bin/sh
# Lasso installer - downloads and installs the Lasso console binary.
# Usage: LASSO_KEY=xxx ./bootstrap.sh
#    or: ./bootstrap.sh --key xxx

set -e

BASE_URL="https://lasso.canyon.cowboylabs.net"

# Parse arguments
KEY="${LASSO_KEY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --key)
      KEY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "Error: API key required. Set LASSO_KEY or pass --key <key>"
  exit 1
fi

# Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *)
    echo "Error: unsupported OS: $OS"
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "Detected platform: ${OS}-${ARCH}"

# Fetch latest version
echo "Fetching latest version..."
VERSION="$(curl -fsSL "${BASE_URL}/latest?key=${KEY}")"
if [ -z "$VERSION" ]; then
  echo "Error: failed to fetch latest version"
  exit 1
fi
echo "Latest version: ${VERSION}"

# Download binary
BINARY="lasso-${OS}-${ARCH}"
URL="${BASE_URL}/${VERSION}/${BINARY}?key=${KEY}"
TMPDIR="$(mktemp -d)"
TMPFILE="${TMPDIR}/lasso"

echo "Downloading ${BINARY}..."
curl -fsSL -o "$TMPFILE" "$URL"
chmod +x "$TMPFILE"

# Install to /usr/local/bin
INSTALL_DIR="/usr/local/bin"
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/lasso"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/lasso"
fi

rm -rf "$TMPDIR"

echo "Lasso ${VERSION} installed to ${INSTALL_DIR}/lasso"
echo "Run 'lasso' to start the console."
