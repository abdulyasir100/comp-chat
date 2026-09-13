"""Download the Live2D Cubism Core into web/vendor/ (not in git).

The Core is Live2D Inc. proprietary software distributed from their CDN under
the Live2D Proprietary Software License; the framework bundle next to it
(cubism-framework.js, Live2D Open Software License) IS in git.

usage:  python scripts/fetch_cubism_core.py
"""
from __future__ import annotations

import os
import sys
import urllib.request

URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
DEST = os.path.join(os.path.dirname(__file__), "..", "web", "vendor", "live2dcubismcore.min.js")


def main() -> int:
    dest = os.path.abspath(DEST)
    req = urllib.request.Request(URL, headers={"User-Agent": "companion-chat/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if b"Live2D Cubism Core" not in data[:400]:
        print("unexpected payload from", URL, file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    print("wrote", dest, len(data), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
