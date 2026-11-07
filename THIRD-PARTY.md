# Third-party data

## color-name-list (meodai/color-names)

Colour names shown in the Colors tab come from the "best of" list of
https://github.com/meodai/color-names — MIT License, Copyright (c) 2017 David Aerne.

## FFmpeg

Murre ships FFmpeg and ffprobe (https://ffmpeg.org) to read render details and make thumbnails. They are built under the
GNU Lesser General Public License, version 2.1 or later, with no GPL or non-free parts and no outside libraries.
FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The programs are linked statically and are not modified. The exact source is the release tarball for the version named
by `FFMPEG_VERSION` in `scripts/make-ffmpeg.sh`, and the configure options used are in that script, so the same build can
be made again. You can swap in your own build by replacing `ffmpeg` and `ffprobe` inside `Murre.app/Contents/MacOS`.
LGPL text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

## Adobe CEP files

The files in `murre-ae/src/js/lib/cep/` (`CSInterface`, `Vulcan` and their type definitions) are Adobe's, from
https://github.com/Adobe-CEP/CEP-Resources, and are covered by Adobe's own terms in their headers, not by Murre's license.
