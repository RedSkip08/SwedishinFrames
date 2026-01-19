#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LUS = DATA / "lus"
FRAMES = DATA / "frames"
CONSTRUCTIONS = DATA / "constructions"
OUT = DATA / "manifest.json"

def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()

lus_files = sorted([rel(p) for p in LUS.glob("*.json")])
frame_files = sorted([rel(p) for p in FRAMES.glob("*.json")])

cx_files = sorted([rel(p) for p in CONSTRUCTIONS.glob("*.json")]) if CONSTRUCTIONS.exists() else []

manifest = {"lus": lus_files, "frames": frame_files, "constructions": cx_files}

OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(
    f"Wrote {OUT} with {len(lus_files)} lus, {len(frame_files)} frames"
    + (f", and {len(cx_files)} constructions." if cx_files else ".")
)
