#!/bin/sh

# Install brigadier from its GitHub release archives. This script is intended for
# use with `curl -fsSL ... | sh`, so it deliberately uses only POSIX shell.
set -eu

repository="stephen-golban/brigadier"
github_url="https://github.com/${repository}"

fail() {
  printf '%s\n' "brigadier installer: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "${staging_directory:-}" ] && { [ -e "$staging_directory" ] || [ -L "$staging_directory" ]; }; then
    rm -rf "$staging_directory"
  fi
  if [ -n "${temporary_directory:-}" ] && [ -d "$temporary_directory" ]; then
    rm -rf "$temporary_directory"
  fi
}

detect_platform() {
  operating_system="$(uname -s)"
  architecture="$(uname -m)"

  case "$operating_system" in
    Darwin) platform_os="darwin" ;;
    Linux) platform_os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) fail "Windows is not supported." ;;
    *) fail "Unsupported operating system: $operating_system. Windows is not supported." ;;
  esac

  case "$architecture" in
    x86_64 | amd64) platform_arch="x64" ;;
    arm64 | aarch64) platform_arch="arm64" ;;
    *) fail "Unsupported architecture: $architecture." ;;
  esac

  platform="${platform_os}-${platform_arch}"
}

download() {
  download_url="$1"
  destination="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$download_url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$destination" "$download_url"
  else
    fail "curl or wget is required to download brigadier."
  fi
}

latest_version_from_redirect() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi

  final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "${github_url}/releases/latest")" || return 1
  tag="${final_url##*/}"
  case "$tag" in
    v?*) printf '%s\n' "${tag#v}" ;;
    *) return 1 ;;
  esac
}

latest_version_from_api() {
  release_metadata="${temporary_directory}/release.json"
  download "https://api.github.com/repos/${repository}/releases/latest" "$release_metadata"
  tag="$(sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$release_metadata" | head -n 1)"
  case "$tag" in
    v?*) printf '%s\n' "${tag#v}" ;;
    *) return 1 ;;
  esac
}

verify_checksum() {
  checksum_name="$1"

  if [ "${BRIGADIER_SKIP_CHECKSUM:-}" = "1" ]; then
    printf '%s\n' "WARNING: BRIGADIER_SKIP_CHECKSUM=1 is set; skipping brigadier archive checksum verification." >&2
    return 0
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$temporary_directory" && sha256sum -c "$checksum_name")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$temporary_directory" && shasum -a 256 -c "$checksum_name")
  else
    fail "sha256sum or shasum is required to verify the brigadier download. Set BRIGADIER_SKIP_CHECKSUM=1 only if you accept the risk."
  fi
}

main() {
  detect_platform
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/brigadier-install.XXXXXX")" || fail "could not create a temporary directory."
  trap cleanup 0 HUP INT TERM

  version="${BRIGADIER_VERSION:-}"
  if [ -z "$version" ]; then
    version="$(latest_version_from_redirect)" || version="$(latest_version_from_api)" || fail "could not discover the latest brigadier release. Set BRIGADIER_VERSION to install a specific version."
  fi
  version="${version#v}"
  [ -n "$version" ] || fail "BRIGADIER_VERSION must not be empty."

  asset="brigadier-${version}-${platform}.tar.gz"
  archive_url="${github_url}/releases/download/v${version}/${asset}"
  archive_path="${temporary_directory}/${asset}"
  checksum_name="${asset}.sha256"

  printf '%s\n' "Downloading brigadier ${version} for ${platform}..."
  download "$archive_url" "$archive_path"
  download "${archive_url}.sha256" "${temporary_directory}/${checksum_name}"
  verify_checksum "$checksum_name"

  tar -xzf "$archive_path" -C "$temporary_directory" || fail "could not extract brigadier archive."
  [ -f "${temporary_directory}/brigadier" ] || fail "release archive did not contain a brigadier binary."

  install_directory="${BRIGADIER_INSTALL_DIR:-${HOME:-}/.local/bin}"
  [ -n "$install_directory" ] || fail "HOME is unset; set BRIGADIER_INSTALL_DIR to choose an install location."
  mkdir -p "$install_directory"
  staging_directory="$(mktemp -d "${install_directory}/.brigadier.install.XXXXXX")" || fail "could not create a staging directory in ${install_directory}."
  staged_binary="${staging_directory}/brigadier"
  cp "${temporary_directory}/brigadier" "$staged_binary"
  chmod +x "$staged_binary"
  destination="${install_directory}/brigadier"
  if [ -L "$destination" ]; then
    rm -f "$destination"
  elif [ -d "$destination" ]; then
    fail "cannot install brigadier: ${destination} is a directory."
  fi
  mv "$staged_binary" "$destination"

  case ":${PATH:-}:" in
    *":${install_directory}:"*) ;;
    *)
      printf '%s\n' "Add this line to your shell profile:"
      printf '%s\n' "export PATH=\"${install_directory}:\$PATH\""
      ;;
  esac

  installed_binary="${install_directory}/brigadier"
  installed_version="$("$installed_binary" --version)"
  printf '%s\n' "Installed brigadier ${installed_version} to ${installed_binary}"

  if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then
    if ! "$installed_binary" init </dev/tty; then
      printf '%s\n' "brigadier setup did not finish. Run brigadier init to try again." >&2
    fi
  else
    printf '%s\n' "No terminal is available; run brigadier init yourself to choose which detected hosts brigadier should work inside."
  fi
}

main "$@"
