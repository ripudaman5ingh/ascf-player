#!/bin/bash
# Starts the ascf convert-and-play portal. Run: ./start.sh
cd "$(dirname "$0")"

# First run: make the venv and install deps
if [ ! -d ".venv" ]; then
  echo "First run: setting up..."
  python3 -m venv .venv
  .venv/bin/pip install -r ASCILINE-main/requirements.txt
fi

# Warn if ffmpeg is missing (needed for audio)
command -v ffmpeg >/dev/null || echo "Note: ffmpeg not found — audio won't be extracted. Install with: brew install ffmpeg"

# Open the browser shortly after the server starts
( sleep 1.5; open http://localhost:8000 ) &

# Start the portal
.venv/bin/python portal.py
