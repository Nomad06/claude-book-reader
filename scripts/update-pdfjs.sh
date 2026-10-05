#!/bin/sh
# Re-vendors pdf.js (the pdfjs-dist package) into viewer/vendor/pdfjs.
#
#   scripts/update-pdfjs.sh            the version in viewer/vendor/pdfjs/VERSION
#   scripts/update-pdfjs.sh 6.5.0      another version
#
# Needs npm. Check the reader afterwards: pdf.js changes its viewer components
# between major versions.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/viewer/vendor/pdfjs"
VERSION=${1:-$(cat "$DEST/VERSION")}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

(cd "$WORK" && npm pack --silent "pdfjs-dist@$VERSION" >/dev/null)
tar -xzf "$WORK"/pdfjs-dist-*.tgz -C "$WORK"
SRC="$WORK/package"

rm -rf "$DEST"
mkdir -p "$DEST/build" "$DEST/web"
cp "$SRC/build/pdf.min.mjs" "$SRC/build/pdf.worker.min.mjs" "$DEST/build/"
cp "$SRC/web/pdf_viewer.mjs" "$SRC/web/pdf_viewer.css" "$DEST/web/"
cp -R "$SRC/web/images" "$DEST/web/"
cp -R "$SRC/cmaps" "$SRC/standard_fonts" "$SRC/wasm" "$SRC/iccs" "$DEST/"
cp "$SRC/LICENSE" "$DEST/"
echo "$VERSION" > "$DEST/VERSION"

echo "pdf.js $VERSION is in viewer/vendor/pdfjs. Update its version in NOTICE too."
