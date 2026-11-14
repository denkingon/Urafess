#!/bin/sh
# URAJI を作り直す：src/ の字形から OTF・WOFF2 と tool/*.html を作る。
# 使い方: ./build.sh            （src/glyphs.js の DEFAULTS の値で）
#         ./build.sh 値.json    （つまみの値を試すとき。例: {"SLIT":0.6,"T":44}）
set -e
cd "$(dirname "$0")"
tmp="$(mktemp)"
node src/export.js ${1:+"$1"} > "$tmp"
python3 src/build.py "$tmp" .
rm -f "$tmp"
python3 tool/build.py
