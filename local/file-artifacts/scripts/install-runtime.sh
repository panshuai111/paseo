#!/bin/sh
set -eu
artifact_runtime="${PASEO_HOME:-$HOME/.paseo}/file-artifacts-runtime"
python3 -m venv "$artifact_runtime"
"$artifact_runtime/bin/python" -m pip install 'openpyxl==3.1.5' 'defusedxml==0.7.1'
for binary in bwrap libreoffice pdfinfo pdftoppm; do
  command -v "$binary" >/dev/null || { echo "Missing conversion dependency: $binary" >&2; exit 1; }
done
