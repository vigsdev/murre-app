#!/usr/bin/env bash
# Makes the ffmpeg.exe and ffprobe.exe that ship inside Murre for Windows, and puts them in src-tauri/binaries/.
#
# Same build as scripts/make-ffmpeg.sh on the Mac: a small LGPL FFmpeg (no GPL parts, no outside libraries) with every
# decoder and only the JPEG encoder, linked in one piece so nothing else has to be installed.
#
# Runs in two places:
#   - On Windows, in an MSYS2 MINGW64 shell (the release workflow does this): the MinGW-w64 compiler builds it natively.
#   - On a Mac or Linux with MinGW-w64 installed (brew install mingw-w64): it cross-compiles, to try the build locally.
#
# The .exe files work beside Murre's own program even though Murre is built with Microsoft's compiler: they are
# separate programs.
set -euo pipefail

VERSION="${FFMPEG_VERSION:-9.0.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries"
WORK="$ROOT/.ffmpeg-build-windows"
# The name Tauri looks for when it builds Murre for Windows.
TRIPLE="x86_64-pc-windows-msvc"

case "$(uname -s)" in
  MINGW*|MSYS*) cross=() ;;
  *) cross=(--enable-cross-compile --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32-) ;;
esac

jobs="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

mkdir -p "$OUT" "$WORK"
cd "$WORK"
if [[ ! -d "ffmpeg-$VERSION" ]]; then
  echo "Downloading FFmpeg ${VERSION}..."
  [[ -f "ffmpeg-${VERSION}.tar.xz" ]] || curl -fL --retry 3 --connect-timeout 20 -o "ffmpeg-${VERSION}.tar.xz" "https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
  tar xf "ffmpeg-$VERSION.tar.xz"
fi

build="$WORK/build"
rm -rf "$build" && mkdir -p "$build" && cd "$build"
# --enable-w32threads: Windows' own threads, so there's no pthreads library to ship.
# -static: the compiler's runtime goes inside the .exe instead of beside it as DLLs.
"$WORK/ffmpeg-$VERSION/configure" \
  --disable-gpl --disable-nonfree --disable-autodetect \
  --disable-doc --disable-debug --disable-network --disable-ffplay \
  --disable-encoders --enable-encoder=mjpeg \
  --disable-muxers --enable-muxer=mjpeg,image2,null \
  --enable-static --disable-shared \
  --enable-w32threads \
  --extra-ldflags="-static" \
  ${cross[@]+"${cross[@]}"}
# Building outside the source folder, one step writes into this folder before make has created it.
mkdir -p fftools/resources
make -j"$jobs" ffmpeg.exe ffprobe.exe

strip_tool="strip"
[[ ${#cross[@]} -gt 0 ]] && strip_tool="x86_64-w64-mingw32-strip"
for tool in ffmpeg ffprobe; do
  cp "$tool.exe" "$OUT/$tool-$TRIPLE.exe"
  "$strip_tool" "$OUT/$tool-$TRIPLE.exe"
done

echo
echo "Done. In $OUT:"
ls -lh "$OUT"/*windows* | awk '{print "  " $5 "  " $9}'
echo
if [[ ${#cross[@]} -eq 0 ]]; then
  "$OUT/ffmpeg-$TRIPLE.exe" -version | head -1
  "$OUT/ffmpeg-$TRIPLE.exe" -version | grep -qi "enable-gpl" && { echo "This build is GPL. It should not be." >&2; exit 1; } || echo "License: LGPL (no GPL parts)."
else
  # Can't run a Windows program here; the configure line inside it still says what it is.
  grep -aq -- "--enable-gpl" "$OUT/ffmpeg-$TRIPLE.exe" && { echo "This build is GPL. It should not be." >&2; exit 1; } || echo "License: LGPL (no GPL parts)."
fi
