"""Download Live2D's free sample model "Haru" into web/assets/models/haru/.

The repo ships no character media. Haru is published by Live2D Inc. under the
Free Material License (https://www.live2d.com/eula/live2d-sample-model-terms_en.html)
in the CubismWebSamples repository; this script fetches exactly the files the
model3.json references so the shipped "sample" card has something to draw.

usage:  python scripts/fetch_sample_model.py [--model Haru] [--force]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

RAW = "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "companion-chat/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Haru")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    name = a.model
    dest = os.path.join(ROOT, "web", "assets", "models", name.lower())
    model3 = f"{name}.model3.json"
    base = RAW + name + "/"

    print("fetching", base + model3)
    raw = fetch(base + model3)
    meta = json.loads(raw.decode("utf-8"))
    fr = meta.get("FileReferences", {})
    files = [model3, fr.get("Moc")]
    files += fr.get("Textures", [])
    for k in ("Physics", "Pose", "UserData", "DisplayInfo"):
        if fr.get(k):
            files.append(fr[k])
    files += [e["File"] for e in fr.get("Expressions", [])]
    for group in fr.get("Motions", {}).values():
        files += [m["File"] for m in group]
        files += [m["Sound"] for m in group if m.get("Sound")]
    files = [f for f in files if f]

    n = 0
    for rel in files:
        out = os.path.join(dest, rel.replace("/", os.sep))
        if os.path.exists(out) and not a.force:
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        data = raw if rel == model3 else fetch(base + rel)
        with open(out, "wb") as f:
            f.write(data)
        n += 1
        print("  ", rel, len(data))
    print(f"{name}: {n} file(s) written to {dest} ({len(files)} referenced)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
