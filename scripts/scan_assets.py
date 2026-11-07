#!/usr/bin/env python3
"""Bangun assets/manifest.js dari isi folder assets/<productId>/.

Browser tidak bisa membaca daftar file di folder, jadi app butuh manifest.
Jalankan script ini setiap kali kamu menambah atau menghapus file aset:

    python scripts/scan_assets.py

Nama folder = productId (kode produk), supaya isi folder selalu bisa
dipetakan ke item di aplikasi.
"""
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUT = ASSETS / "manifest.js"

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v", ".avi"}


def kind(suffix: str) -> str:
    if suffix in IMAGE_EXT:
        return "image"
    if suffix in VIDEO_EXT:
        return "video"
    return "other"


def main() -> None:
    items = {}
    if ASSETS.exists():
        for folder in sorted(ASSETS.iterdir()):
            if not folder.is_dir():
                continue
            files = []
            for f in sorted(folder.iterdir()):
                if not f.is_file() or f.name.startswith("."):
                    continue
                files.append({
                    "file": f.name,
                    "kind": kind(f.suffix.lower()),
                    "bytes": f.stat().st_size,
                })
            if files:
                items[folder.name] = files

    payload = {"generatedAt": int(time.time() * 1000), "items": items}
    ASSETS.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "window.ASSET_MANIFEST = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    total = sum(len(v) for v in items.values())
    print(f"{len(items)} produk, {total} file -> {OUT}")


if __name__ == "__main__":
    main()
