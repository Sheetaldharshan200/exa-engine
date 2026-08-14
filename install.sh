#!/bin/sh
# exa by Exasol — CLI installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/Sheetaldharshan200/exa/exa-main/install.sh | sh
#
# Options (env vars):
#   VERSION=1.18.12-exa.14   install a specific release (default: latest)
#   EXA_INSTALL_DIR=~/.local/bin   install directory (default shown)
set -eu

REPO="Sheetaldharshan200/exa"
INSTALL_DIR="${EXA_INSTALL_DIR:-$HOME/.local/bin}"
GREEN="$(printf '\033[38;2;95;195;59m')"
BOLD="$(printf '\033[1m')"
RESET="$(printf '\033[0m')"

# The EXA wordmark — same solid blocks as the CLI splash, X's left chevron in
# Exasol green.
printf '%s\n' ""
printf '%s███████%s %s██  %s ██ %s█████ %s\n'  "$BOLD" "$RESET" "$GREEN" "$RESET$BOLD" "$RESET$BOLD" "$RESET"
printf '%s██     %s %s ██ %s██ ██   ██%s\n'    "$BOLD" "$RESET" "$GREEN" "$RESET$BOLD" "$RESET"
printf '%s█████  %s %s  ██%s█  ███████%s\n'    "$BOLD" "$RESET" "$GREEN" "$RESET$BOLD" "$RESET"
printf '%s██     %s %s ██ %s██ ██   ██%s\n'    "$BOLD" "$RESET" "$GREEN" "$RESET$BOLD" "$RESET"
printf '%s███████%s %s██  %s ██ ██   ██%s\n'   "$BOLD" "$RESET" "$GREEN" "$RESET$BOLD" "$RESET"
printf '%sby Exasol%s\n\n' "$BOLD" "$RESET"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported OS: $os (use the Windows zip from https://github.com/$REPO/releases)" ;;
esac
case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64) cpu="x64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac

# musl systems (Alpine, ...) get the static-friendly build.
suffix=""
if [ "$platform" = "linux" ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
  suffix="-musl"
fi

if [ "$platform" = "linux" ]; then
  asset="exa-linux-${cpu}${suffix}.tar.gz"
else
  asset="exa-darwin-${cpu}.zip"
fi

if [ -n "${VERSION:-}" ]; then
  tag="v${VERSION#v}"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$tag" ] || fail "could not resolve the latest release of $REPO"
fi

url="https://github.com/$REPO/releases/download/$tag/$asset"
printf 'installing %s%s%s (%s) to %s\n' "$BOLD" "$tag" "$RESET" "$asset" "$INSTALL_DIR"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset" "$url" || fail "download failed: $url"

mkdir -p "$INSTALL_DIR"
case "$asset" in
  *.tar.gz) tar -xzf "$tmp/$asset" -C "$tmp" ;;
  *.zip) unzip -q "$tmp/$asset" -d "$tmp" ;;
esac
[ -f "$tmp/exa" ] || fail "archive did not contain the exa binary"
# Install atomically so a running exa is not truncated mid-write.
install -m 755 "$tmp/exa" "$INSTALL_DIR/exa.new"
mv -f "$INSTALL_DIR/exa.new" "$INSTALL_DIR/exa"

printf '%s✓%s installed: %s/exa (%s)\n' "$GREEN" "$RESET" "$INSTALL_DIR" "$("$INSTALL_DIR/exa" --version 2>/dev/null || echo "$tag")"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'add it to your PATH: export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
esac
printf 'start with: %sexa%s   (sandbox: exa sandbox on|off, SQL grants: exa ops)\n' "$BOLD" "$RESET"
