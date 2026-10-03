#!/usr/bin/env bash
# Bundle aliena_pdf_to_ofx.py into a standalone binary for the desktop app.
# Output: dist-python/aliena_pdf_to_ofx (native architecture of this machine)
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
if [[ -x .venv/bin/python && -z "${CI:-}" ]]; then
  PYTHON=.venv/bin/python
fi

"$PYTHON" -m pip install --quiet -r requirements.txt -r requirements-build.txt
"$PYTHON" -m PyInstaller \
  --onefile \
  --noconfirm \
  --clean \
  --name aliena_pdf_to_ofx \
  --distpath dist-python \
  --workpath build-python \
  --specpath build-python \
  aliena_pdf_to_ofx.py

echo "Built dist-python/aliena_pdf_to_ofx"
