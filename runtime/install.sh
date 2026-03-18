#!/usr/bin/env bash
set -euo pipefail

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
INSTALL_DIR="$HOME/.local/bin"

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW"
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"

log() {
  echo "[install] $*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

try_cmd() {
  "$@" >/dev/null 2>&1
}

add_path_hint() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      echo
      echo "Add $INSTALL_DIR to your PATH if needed:"
      echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
}

install_with_brew() {
  local pkg="$1"
  if have_cmd brew; then
    log "Installing $pkg with Homebrew..."
    if brew install "$pkg"; then
      return 0
    fi
  fi
  return 1
}

download_to() {
  local url="$1"
  local output="$2"
  if have_cmd curl; then
    curl -fsSL "$url" -o "$output"
  elif have_cmd wget; then
    wget -qO "$output" "$url"
  else
    log "Neither curl nor wget is available"
    return 1
  fi
}

install_ngrok() {
  if have_cmd ngrok; then
    log "ngrok already installed: $(command -v ngrok)"
    return 0
  fi

  install_with_brew "ngrok/ngrok/ngrok" || install_with_brew "ngrok" || true
  if have_cmd ngrok; then
    return 0
  fi

  if have_cmd npm; then
    log "Trying npm global install for ngrok..."
    if npm install -g ngrok; then
      return 0
    fi
  fi

  local platform
  case "$OS" in
    darwin) platform="darwin" ;;
    linux) platform="linux" ;;
    *)
      log "Unsupported OS for ngrok auto-download: $OS"
      return 1
      ;;
  esac

  if ! have_cmd unzip; then
    log "unzip is required for ngrok auto-download but not found"
    return 1
  fi

  local tmpdir zipfile url
  tmpdir="$(mktemp -d)"
  zipfile="$tmpdir/ngrok.zip"
  url="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${platform}-${ARCH}.zip"

  log "Downloading ngrok from $url"
  download_to "$url" "$zipfile"
  unzip -oq "$zipfile" -d "$tmpdir"
  install -m 0755 "$tmpdir/ngrok" "$INSTALL_DIR/ngrok"
  rm -rf "$tmpdir"

  if have_cmd ngrok; then
    return 0
  fi

  if [ -x "$INSTALL_DIR/ngrok" ]; then
    return 0
  fi

  return 1
}

install_cloudflared() {
  if have_cmd cloudflared; then
    log "cloudflared already installed: $(command -v cloudflared)"
    return 0
  fi

  install_with_brew "cloudflared" || true
  if have_cmd cloudflared; then
    return 0
  fi

  # Best-effort Linux package managers
  if [ "$OS" = "linux" ]; then
    if have_cmd apt-get; then
      log "Trying apt-get install cloudflared..."
      sudo apt-get update -y && sudo apt-get install -y cloudflared || true
    elif have_cmd dnf; then
      log "Trying dnf install cloudflared..."
      sudo dnf install -y cloudflared || true
    elif have_cmd yum; then
      log "Trying yum install cloudflared..."
      sudo yum install -y cloudflared || true
    elif have_cmd apk; then
      log "Trying apk add cloudflared..."
      sudo apk add cloudflared || true
    fi
  fi

  if have_cmd cloudflared; then
    return 0
  fi

  local asset
  case "$OS" in
    darwin)
      asset="cloudflared-darwin-${ARCH}.tgz"
      ;;
    linux)
      asset="cloudflared-linux-${ARCH}.tgz"
      ;;
    *)
      log "Unsupported OS for cloudflared auto-download: $OS"
      return 1
      ;;
  esac

  local tmpdir tarfile url
  tmpdir="$(mktemp -d)"
  tarfile="$tmpdir/cloudflared.tgz"
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"

  log "Downloading cloudflared from $url"
  download_to "$url" "$tarfile"
  tar -xzf "$tarfile" -C "$tmpdir"
  install -m 0755 "$tmpdir/cloudflared" "$INSTALL_DIR/cloudflared"
  rm -rf "$tmpdir"

  if have_cmd cloudflared; then
    return 0
  fi

  if [ -x "$INSTALL_DIR/cloudflared" ]; then
    return 0
  fi

  return 1
}

print_ngrok_auth_hint() {
  if ! have_cmd ngrok && [ ! -x "$INSTALL_DIR/ngrok" ]; then
    return
  fi

  local ngrok_bin
  ngrok_bin="$(command -v ngrok || true)"
  if [ -z "$ngrok_bin" ] && [ -x "$INSTALL_DIR/ngrok" ]; then
    ngrok_bin="$INSTALL_DIR/ngrok"
  fi

  if [ ! -f "$HOME/.config/ngrok/ngrok.yml" ] && [ ! -f "$HOME/Library/Application Support/ngrok/ngrok.yml" ]; then
    echo
    echo "ngrok is installed but may need auth token setup:"
    echo "  $ngrok_bin config add-authtoken <YOUR_NGROK_TOKEN>"
  fi
}

main() {
  echo "Installing tunnel dependencies (ngrok + cloudflared)..."

  local ngrok_ok=0
  local cloudflared_ok=0

  if install_ngrok; then
    ngrok_ok=1
  else
    log "Failed to auto-install ngrok"
  fi

  if install_cloudflared; then
    cloudflared_ok=1
  else
    log "Failed to auto-install cloudflared"
  fi

  echo
  echo "Install summary:"
  echo "  ngrok:       $([ "$ngrok_ok" -eq 1 ] && echo "ok" || echo "failed")"
  echo "  cloudflared: $([ "$cloudflared_ok" -eq 1 ] && echo "ok" || echo "failed")"

  add_path_hint
  print_ngrok_auth_hint

  if [ "$ngrok_ok" -eq 0 ] && [ "$cloudflared_ok" -eq 0 ]; then
    exit 1
  fi
}

main "$@"
