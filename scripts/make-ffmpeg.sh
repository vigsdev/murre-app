#!/usr/bin/env bash
# Makes the ffmpeg and ffprobe that ship inside Murre, and puts them in src-tauri/binaries/.
#
#   scripts/make-ffmpeg.sh            builds for this Mac's chip
#   scripts/make-ffmpeg.sh --both     builds for Apple Silicon and Intel, and a universal one for `tauri build --target universal-apple-darwin`
#
# What it makes: a small LGPL build of FFmpeg (no GPL parts such as x264, no outside libraries), linked in one piece so
# nothing else has to be installed. It keeps every decoder (so any render After Effects makes can be read) but only
# the JPEG encoder, which is all Murre uses for thumbnails. Expect roughly 15 to 30 MB per program and a few minutes.
#
# Needs: Xcode command line tools (xcode-select --install). For the Intel build on an Apple Silicon Mac, also: brew install nasm
set -euo pipefail

VERSION="${FFMPEG_VERSION:-9.0.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries"
WORK="$ROOT/.ffmpeg-build"
MIN_MACOS="12.0"

host_arch="$(uname -m)"          # arm64 or x86_64
want=("$host_arch")
[[ "${1:-}" == "--both" ]] && want=(arm64 x86_64)

triple_for() { [[ "$1" == "arm64" ]] && echo "aarch64-apple-darwin" || echo "x86_64-apple-darwin"; }

mkdir -p "$OUT" "$WORK"
cd "$WORK"
if [[ ! -d "ffmpeg-$VERSION" ]]; then
  echo "Downloading FFmpeg ${VERSION}..."
  [[ -f "ffmpeg-${VERSION}.tar.xz" ]] || curl -fL --retry 3 --connect-timeout 20 -o "ffmpeg-${VERSION}.tar.xz" "https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
  tar xf "ffmpeg-$VERSION.tar.xz"
fi

for arch in "${want[@]}"; do
  triple="$(triple_for "$arch")"
  echo "Building for ${arch}..."
  build="$WORK/build-$arch"
  rm -rf "$build" && mkdir -p "$build" && cd "$build"
  extra=()
  if [[ "$arch" != "$host_arch" ]]; then
    ffarch="x86_64"; [[ "$arch" == "arm64" ]] && ffarch="aarch64"
    extra=(--enable-cross-compile --arch="$ffarch" --target-os=darwin --cc="clang -arch $arch")
  fi
  "$WORK/ffmpeg-$VERSION/configure" \
    --disable-gpl --disable-nonfree --disable-autodetect \
    --disable-doc --disable-debug --disable-network --disable-ffplay \
    --disable-encoders --enable-encoder=mjpeg \
    --disable-muxers --enable-muxer=mjpeg,image2,null \
    --enable-static --disable-shared \
    --extra-cflags="-mmacosx-version-min=$MIN_MACOS" --extra-ldflags="-mmacosx-version-min=$MIN_MACOS" \
    ${extra[@]+"${extra[@]}"}
  make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
  for tool in ffmpeg ffprobe; do
    cp "$tool" "$OUT/$tool-$triple"
    strip "$OUT/$tool-$triple"
    # Apple Silicon refuses to run a program that is not signed at all. This is enough for that; the release build
    # signs it again with your Developer ID along with the rest of the app.
    codesign --force --sign - "$OUT/$tool-$triple"
  done
  cd "$WORK"
done

if [[ ${#want[@]} -eq 2 ]]; then
  for tool in ffmpeg ffprobe; do
    lipo -create "$OUT/$tool-aarch64-apple-darwin" "$OUT/$tool-x86_64-apple-darwin" -output "$OUT/$tool-universal-apple-darwin"
    codesign --force --sign - "$OUT/$tool-universal-apple-darwin"
  done
fi

echo
echo "Done. In $OUT:"
ls -lh "$OUT" | awk 'NR>1 {print "  " $5 "  " $9}'
echo
# Only the chip this Mac has can be tried here.
"$OUT/ffmpeg-$(triple_for "$host_arch")" -version | head -1
"$OUT/ffmpeg-$(triple_for "$host_arch")" -version | grep -qi "enable-gpl" && { echo "This build is GPL. It should not be." >&2; exit 1; } || echo "License: LGPL (no GPL parts)."
