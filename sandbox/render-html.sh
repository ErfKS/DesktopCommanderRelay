#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
    echo "Usage: render-html INPUT_HTML OUTPUT_BASE [WIDTH] [HEIGHT]" >&2
    echo "Example:" >&2
    echo "  render-html /workspace/index.html /workspace/.artifacts/page 1440 1600" >&2
    exit 2
fi

INPUT_HTML="$1"
OUTPUT_BASE="$2"
WIDTH="${3:-1440}"
HEIGHT="${4:-1600}"

if [ ! -f "$INPUT_HTML" ]; then
    echo "Input HTML does not exist: $INPUT_HTML" >&2
    exit 3
fi

case "$WIDTH" in
    *[!0-9]*|'')
        echo "WIDTH must be an integer." >&2
        exit 4
        ;;
esac

case "$HEIGHT" in
    *[!0-9]*|'')
        echo "HEIGHT must be an integer." >&2
        exit 4
        ;;
esac

OUTPUT_DIR="$(dirname "$OUTPUT_BASE")"
mkdir -p "$OUTPUT_DIR"

PNG_OUTPUT="${OUTPUT_BASE}.png"
PREVIEW_OUTPUT="${OUTPUT_BASE}-preview.jpg"

INPUT_URI="$(
python3 - "$INPUT_HTML" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve().as_uri())
PY
)"

chromium-headless-shell \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --hide-scrollbars \
    --allow-file-access-from-files \
    --run-all-compositor-stages-before-draw \
    --virtual-time-budget=1500 \
    --window-size="${WIDTH},${HEIGHT}" \
    --screenshot="$PNG_OUTPUT" \
    "$INPUT_URI"

if [ ! -s "$PNG_OUTPUT" ]; then
    echo "Chromium did not produce a screenshot." >&2
    exit 5
fi

magick "$PNG_OUTPUT" \
    -strip \
    -resize '1600x1600>' \
    -quality 82 \
    "$PREVIEW_OUTPUT"

if [ ! -s "$PREVIEW_OUTPUT" ]; then
    echo "ImageMagick did not produce the preview." >&2
    exit 6
fi

echo "Screenshot: $PNG_OUTPUT"
echo "Preview:    $PREVIEW_OUTPUT"
