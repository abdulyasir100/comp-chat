"""Stage the web/ tree for packaging — tracked files only, plus an allowlist.

Packaging used to bundle web/ verbatim. A dev checkout has gitignored media
in there (restored Ryza media, private Live2D models, provider files), so a
local build would ship IP it must not. This copies:

  * every git-tracked file under web/
  * an allowlist of gitignored files that ARE redistributable and that the
    app needs at runtime:
      - vendor/live2dcubismcore.min.js  (Live2D Cubism Core — embeddable per
        the Live2D Proprietary Software License)
      - assets/models/haru/**           (Live2D free sample model, Aria's pack)
      - assets/fonts/*.ttf              (Noto Sans JP + Hina Mincho, SIL OFL)

Everything else under web/ (Ryza spine/audio/images, private models, the
gitignored assets/characters-private/ cards, imported packs, config) is left out. Output: output/web-stage (wiped every run).

--full stages ALL of web/ verbatim (every gitignored media file, every card,
no index rewrite): the personal build for the owner's own devices, with the
licensed Ryza media, BGM, backgrounds and the private cards. Never publish a
--full package.

usage: python scripts/stage_web.py [--full] [<out-dir>]
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")

ALLOW_IGNORED = [
    "vendor/live2dcubismcore.min.js",
    "assets/models/haru",
    "assets/fonts",
]
# Tracked in a checkout but never packaged (private character cards): add
# "assets/characters/<id>/" entries here.
DENY_PREFIX = []
ALLOW_EXT = {".ttf", ".otf", ".js", ".json", ".moc3", ".png", ".motion3.json",
             ".exp3.json", ".physics3.json", ".pose3.json", ".cdi3.json", ".userdata3.json"}


def tracked():
    out = subprocess.check_output(["git", "ls-files", "-z", "web"], cwd=ROOT)
    return [p for p in out.decode("utf-8").split("\0") if p]


def walk_allow(rel):
    full = os.path.join(WEB, rel)
    if os.path.isfile(full):
        yield rel
        return
    for r, _d, files in os.walk(full):
        for f in files:
            p = os.path.join(r, f)
            if os.path.splitext(f)[1].lower() in ALLOW_EXT or f.endswith((".motion3.json", ".exp3.json")):
                yield os.path.relpath(p, WEB).replace(os.sep, "/")


def walk_all():
    for r, _d, files in os.walk(WEB):
        for f in files:
            yield os.path.relpath(os.path.join(r, f), WEB).replace(os.sep, "/")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = "--full" in sys.argv[1:]
    out = args[0] if args else os.path.join(ROOT, "output", "web-stage")
    out = os.path.abspath(out)
    shutil.rmtree(out, ignore_errors=True)
    n = 0
    seen = set()
    if full:
        rels = list(walk_all())
        deny = []
    else:
        rels = [p[len("web/"):] for p in tracked()]
        for a in ALLOW_IGNORED:
            rels.extend(walk_allow(a))
        deny = DENY_PREFIX
    for rel in rels:
        if rel in seen or any(rel.startswith(d) for d in deny):
            continue
        seen.add(rel)
        src = os.path.join(WEB, rel)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        n += 1
    # the character index must only list cards that were actually staged
    # (the first id is the default card, Characters.activeId)
    idx = os.path.join(out, "assets", "characters", "index.json")
    if os.path.isfile(idx) and not full:
        import json
        ids = json.load(open(idx, encoding="utf-8"))
        kept = [i for i in ids if os.path.isfile(os.path.join(out, "assets", "characters", i, "character.json"))]
        json.dump(kept, open(idx, "w", encoding="utf-8"))
        print("character index:", kept)
    missing = [] if full else [a for a in ALLOW_IGNORED if not os.path.exists(os.path.join(WEB, a))]
    print("staged %d files -> %s%s" % (n, out, "  [FULL: licensed media included, personal build only]" if full else ""))
    if missing:
        print("WARNING: allowlisted media missing (fetch_cubism_core.py / fetch_sample_model.py):", missing)
    return 0


if __name__ == "__main__":
    sys.exit(main())
