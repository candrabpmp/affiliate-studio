#!/usr/bin/env python3
"""Ambil gambar & video produk Shopee -> assets/<productId>/

Skrip ini dipanggil otomatis oleh extract_batch.py setelah detail produk
berhasil diambil, memakai HTML yang SAMA (tidak membuka Chrome dua kali).

Bisa juga dijalankan manual:
    python scripts/extract_media.py 41678605428 41561442154
    python scripts/extract_media.py --all      # semua produk di data/detail_produk.json
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
CACHE = ROOT / "data" / "detail_produk.json"

IMG_BASE = "https://down-id.img.susercontent.com/file/"
MAX_VIDEO_H = 720          # 540p/720p cukup untuk konten; 1080p boros kuota
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def item_from_html(html: str):
    """Ambil objek JSON `item` dari DOM Shopee (sumber yang sama dengan detail)."""
    i = html.find('"item":{"item_id":')
    if i == -1:
        return None
    try:
        item, _ = json.JSONDecoder().raw_decode(html[i + 7:])
    except Exception:
        return None
    return item


def media_of(item: dict):
    """Daftar URL gambar + video dari objek item Shopee."""
    images = [IMG_BASE + str(x) for x in (item.get("images") or []) if x]
    videos = []
    for v in (item.get("video_info_list") or []):
        fmts = [f for f in (v.get("formats") or []) if f.get("url")]
        if not fmts:
            continue
        under = [f for f in fmts if (f.get("height") or 0) <= MAX_VIDEO_H]
        pick = max(under, key=lambda f: f.get("height") or 0) if under else min(
            fmts, key=lambda f: f.get("height") or 99999)
        thumb = v.get("thumb_url")
        videos.append({
            "url": pick["url"],
            "width": pick.get("width"),
            "height": pick.get("height"),
            "duration": v.get("duration"),
            "thumb": (IMG_BASE + str(thumb)) if thumb else None,
        })
    return {"images": images, "videos": videos}


def _download(url: str, dest: Path, retries: int = 2) -> int:
    """Unduh satu file. Kembalikan ukuran byte; 0 kalau gagal."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest.stat().st_size
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://shopee.co.id/",
        "Accept": "*/*",
    })
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read()
            if not data:
                raise IOError("kosong")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return len(data)
        except Exception as e:
            if attempt >= retries:
                print(f"   ! media gagal {dest.name}: {e}", flush=True)
                return 0
            time.sleep(1.5)
    return 0


def save_for(pid: str, item: dict, quiet: bool = False) -> dict:
    """Unduh semua media satu produk ke assets/<pid>/. Idempoten (skip yang ada)."""
    m = media_of(item)
    folder = ASSETS / pid
    n_img = n_vid = 0
    total = 0

    for idx, url in enumerate(m["images"], 1):
        size = _download(url, folder / f"img-{idx:02d}.jpg")
        if size:
            n_img += 1
            total += size

    for idx, v in enumerate(m["videos"], 1):
        size = _download(v["url"], folder / f"video-{idx:02d}.mp4")
        if size:
            n_vid += 1
            total += size
        if v.get("thumb"):
            total += _download(v["thumb"], folder / f"video-{idx:02d}-thumb.jpg")

    if n_img == 0 and n_vid == 0:
        # Penanda: produk ini memang tidak punya media. Tanpa file ini, produk
        # akan terus masuk antrean "belum punya media" setiap kali ekstraksi.
        folder.mkdir(parents=True, exist_ok=True)
        (folder / ".media-none").write_text("produk tanpa media di halaman Shopee\n",
                                            encoding="utf-8")

    if not quiet:
        mb = total / (1024 * 1024)
        print(f"   media: {n_img} gambar + {n_vid} video ({mb:.1f} MB) -> assets/{pid}",
              flush=True)
    return {"images": n_img, "videos": n_vid, "bytes": total}


def rebuild_manifest():
    """Segarkan assets/manifest.js supaya aplikasi tahu file barunya."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import scan_assets
    scan_assets.main()


def run_ids(pids):
    """Untuk pemakaian manual: ambil media dari cache detail (butuh Chrome)."""
    import subprocess
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    for pid in pids:
        row = cache.get(pid) or {}
        shop = row.get("shop_id")
        if not shop:
            print(f"{pid}: shop_id tidak ada di cache — lewati", flush=True)
            continue
        url = f"https://shopee.co.id/product/{shop}/{pid}"
        print(f"Ambil media {pid} …", flush=True)
        proc = subprocess.run([chrome, "--headless=new", "--virtual-time-budget=15000",
                               "--dump-dom", url], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, encoding="utf-8",
                              errors="ignore")
        item = item_from_html(proc.stdout or "")
        if not item:
            print(f"{pid}: DOM tidak bisa dibaca — lewati", flush=True)
            continue
        save_for(pid, item)
    rebuild_manifest()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--all" in sys.argv:
        cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
        args = list(cache.keys())
    if not args:
        print(__doc__)
        sys.exit(1)
    run_ids(args)
