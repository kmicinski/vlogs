"""Build dist/KrisVideos.app: a launcher that starts the local server and opens a chromeless Chrome window.

    uv run python scripts/make_app.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "dist" / "KrisVideos.app"
PORT = 8765


def make_icon(dst_icns: Path) -> None:
    iconset = dst_icns.with_suffix(".iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir(parents=True)
    base = 1024
    img = Image.new("RGBA", (base, base), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # macOS-style rounded square with a gradient
    grad = Image.new("RGBA", (base, base))
    gd = ImageDraw.Draw(grad)
    for y in range(base):
        t = y / base
        gd.line([(0, y), (base, y)], fill=(int(91 + (167 - 91) * t), int(140 - (140 - 139) * t), int(255 - (255 - 250) * t), 255))
    mask = Image.new("L", (base, base), 0)
    ImageDraw.Draw(mask).rounded_rectangle([90, 90, base - 90, base - 90], radius=200, fill=255)
    img.paste(grad, (0, 0), mask)
    # clapper top
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([230, 300, 794, 420], radius=30, fill=(20, 20, 28, 255))
    for i in range(5):
        x = 260 + i * 110
        d.polygon([(x, 300), (x + 60, 300), (x + 20, 420), (x - 40, 420)], fill=(240, 240, 248, 255))
    d.rounded_rectangle([230, 440, 794, 760], radius=40, fill=(20, 20, 28, 255))
    # play triangle
    d.polygon([(450, 510), (450, 690), (610, 600)], fill=(240, 240, 248, 255))
    for size in (16, 32, 64, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
            img.resize((px, px), Image.LANCZOS).save(iconset / name)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(dst_icns)], check=True)
    shutil.rmtree(iconset)


def main() -> None:
    contents = APP / "Contents"
    shutil.rmtree(APP, ignore_errors=True)
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir(parents=True)
    make_icon(contents / "Resources" / "AppIcon.icns")
    (contents / "Info.plist").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>KrisVideos</string>
  <key>CFBundleDisplayName</key><string>KrisVideos</string>
  <key>CFBundleIdentifier</key><string>com.kmicinski.krisvideos</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>KrisVideos</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
""")
    launcher = contents / "MacOS" / "KrisVideos"
    launcher.write_text(f"""#!/bin/bash
# KrisVideos launcher: start the local server (if not already running) and open the GUI.
REPO="{REPO}"
PORT={PORT}
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/krisvideos.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

alive() {{ curl -s --max-time 1 "$URL/api/settings" >/dev/null 2>&1; }}

# If a server is running but the code changed since it started, restart it.
PIDF="$HOME/Library/Application Support/krisvideos/server-$PORT.pid"
if alive && [ -f "$PIDF" ]; then
  PID=$(cat "$PIDF")
  if [ -n "$(find "$REPO/src" -newer "$PIDF" -name '*.py' -o -newer "$PIDF" -name '*.js' -o -newer "$PIDF" -name '*.css' -o -newer "$PIDF" -name '*.html' 2>/dev/null | head -1)" ]; then
    kill "$PID" 2>/dev/null; sleep 1
  fi
fi

if ! alive; then
  cd "$REPO" || exit 1
  if [ ! -x .venv/bin/vlog ]; then uv sync >>"$LOG" 2>&1; fi
  nohup .venv/bin/vlog serve --port "$PORT" >>"$LOG" 2>&1 &
  for _ in $(seq 1 60); do alive && break; sleep 0.25; done
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --window-size=1500,950
else
  open "$URL"
fi
""")
    os.chmod(launcher, 0o755)
    print(f"built {APP}")


if __name__ == "__main__":
    main()
