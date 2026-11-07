#!/usr/bin/env python3
"""Ekstrak detail produk Shopee -> data/detail_produk.json

Sumber daftar produk (urut prioritas):
  1. data/pending.json          (diunduh dari tombol "Ekstrak detail pending")
  2. ~/Downloads/pending.json   (kalau tidak dipindah ke folder data/)
  3. daftar contoh di bawah     (hanya kalau dua file di atas tidak ada)

Produk yang sudah sukses diekstrak dilewati, jadi skrip ini aman dijalankan
berulang kali: hanya yang belum punya detail yang benar-benar diambil.
"""
import importlib.util
import json
import random
import subprocess
import sys
import time
from pathlib import Path

SRC = Path(r"C:\Users\CANDRA\AppData\Local\hermes\profiles\crwel-knowledgebase\skills\shopee-product-extractor\scripts\extract_product.py")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "detail_produk.json"
OUT.parent.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_media  # noqa: E402  (butuh ROOT dihitung dulu)

# Ekstraktor pihak ketiga memanggil Chrome lewat subprocess.run lalu membuang
# HTML-nya. Kita intip hasil yang sama supaya gambar & video bisa diambil dari
# satu kali buka halaman — bukan dua kali (15 detik per produk).
_CAP = {}
_run_asli = subprocess.run


def _run_intip(*a, **kw):
    r = _run_asli(*a, **kw)
    _CAP["html"] = getattr(r, "stdout", "") or ""
    return r


subprocess.run = _run_intip

spec = importlib.util.spec_from_file_location("ep", str(SRC))
ep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ep)

SAMPLE_ITEMS = [
    ("41678605428", "https://shopee.co.id/product/39404232/41678605428"),
    ("41561442154", "https://shopee.co.id/product/607593297/41561442154"),
    ("46964793009", "https://shopee.co.id/product/742479216/46964793009"),
    ("40622871786", "https://shopee.co.id/product/1645771906/40622871786"),
    ("50661100069", "https://shopee.co.id/product/1106667928/50661100069"),
    ("41463430148", "https://shopee.co.id/product/1537007269/41463430148"),
    ("27069197841", "https://shopee.co.id/product/1099311071/27069197841"),
    ("41620728444", "https://shopee.co.id/product/798699454/41620728444"),
    ("28425599035", "https://shopee.co.id/product/1471355665/28425599035"),
    ("23718614219", "https://shopee.co.id/product/799175511/23718614219"),
]


def load_pending(allow_sample=False):
    """Baca daftar produk dari pending.json (data/ dulu, lalu Downloads).

    Sengaja TIDAK diam-diam memakai daftar contoh: kalau pending.json tidak ada,
    skrip berhenti dengan instruksi. Dulu daftar contoh dipakai sebagai fallback
    sehingga menjalankan skrip tanpa mengunduh daftar akan mengekstrak 10 produk
    yang salah tanpa peringatan.
    """
    for path in (ROOT / "data" / "pending.json", Path.home() / "Downloads" / "pending.json"):
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"! {path.name} tidak bisa dibaca: {e}", flush=True)
            continue
        items = []
        for row in raw:
            if isinstance(row, dict):
                pid = str(row.get("id") or "").strip()
                url = str(row.get("url") or "").strip()
            else:
                pid, url = str(row).strip(), ""
            if not pid:
                continue
            items.append((pid, url or f"https://shopee.co.id/product/{pid}"))
        if items:
            print(f"Sumber: {path} ({len(items)} produk)", flush=True)
            return items
        print(f"! {path} kosong — tidak ada produk untuk diekstrak.", flush=True)
        return []

    if allow_sample:
        print("Sumber: daftar contoh (--sample)", flush=True)
        return SAMPLE_ITEMS

    print("BERHENTI: pending.json tidak ditemukan.", flush=True)
    print("  Buka aplikasi -> tab Data Produk -> tombol 'Ekstrak detail (N)'.", flush=True)
    print("  File pending.json akan terunduh ke Downloads; pindahkan ke data/ atau biarkan di Downloads.", flush=True)
    print("  Untuk uji coba dengan 10 produk contoh, jalankan: python scripts/extract_batch.py --sample", flush=True)
    sys.exit(1)


ITEMS = load_pending("--sample" in sys.argv)
if not ITEMS:
    print("Tidak ada yang perlu diekstrak.", flush=True)
    sys.exit(0)


def write_detail_js(results):
    """Tulis ulang detail.js dari hasil ekstraksi.

    Tanpa langkah ini detail hanya hidup di localStorage: begitu data browser
    dibersihkan, detail yang sudah diambil hilang dan harus diekstrak ulang.
    """
    ok = {k: v for k, v in results.items() if v.get("status") == "success"}
    clean = {}
    for pid, row in ok.items():
        clean[pid] = {k: val for k, val in row.items() if k not in ("status", "elapsed", "message")}
    target = ROOT / "detail.js"
    body = json.dumps(clean, ensure_ascii=False, indent=1)
    target.write_text(
        "/* Auto-generated oleh scripts/extract_batch.py — jangan edit manual */\n"
        "window.DETAIL_DATA = " + body + ";\n",
        encoding="utf-8",
    )
    print(f"detail.js diperbarui: {len(clean)} produk", flush=True)

results = {}
if OUT.exists():
    try:
        results = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        results = {}

hasil_media = {"images": 0, "videos": 0, "bytes": 0}


def ambil_media(pid, item):
    """Unduh gambar/video produk; kegagalan media tidak menggagalkan detail."""
    if not item:
        print(f"   media: dilewati (DOM tidak terbaca)", flush=True)
        return
    try:
        r = extract_media.save_for(pid, item)
        for k in hasil_media:
            hasil_media[k] += r[k]
    except Exception as e:
        print(f"   media: gagal — {e}", flush=True)


for i, (pid, url) in enumerate(ITEMS, 1):
    if pid in results and results[pid].get("status") == "success":
        folder = extract_media.ASSETS / pid
        punya_media = folder.exists() and any(folder.iterdir())
        if punya_media:
            print(f"[{i}/{len(ITEMS)}] SKIP (sudah ada) {pid}", flush=True)
            continue
        # Detail sudah ada tapi media belum pernah diambil (produk lama).
        # Ambil media saja, detail tidak ditimpa.
        print(f"[{i}/{len(ITEMS)}] SKIP detail (sudah ada) {pid} — ambil media", flush=True)
        try:
            ep.extract_shopee_product(url)
        except Exception as e:
            print(f"   media: gagal membuka halaman — {e}", flush=True)
            continue
        ambil_media(pid, extract_media.item_from_html(_CAP.get("html") or ""))
        continue
    print(f"[{i}/{len(ITEMS)}] Ambil {pid} ...", flush=True)
    t0 = time.time()
    try:
        data = ep.extract_shopee_product(url)
    except Exception as e:
        data = {"status": "error", "message": f"exception: {e}"}
    data["elapsed"] = round(time.time() - t0, 1)
    results[pid] = data
    ok = data.get("status") == "success"
    print(f"   -> {'OK' if ok else 'GAGAL'} {data.get('title', data.get('message', ''))[:60]} ({data['elapsed']}s)", flush=True)
    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    if ok:
        ambil_media(pid, extract_media.item_from_html(_CAP.get("html") or ""))
    if i < len(ITEMS):
        time.sleep(random.uniform(9, 15))

ok_n = sum(1 for pid, _ in ITEMS if (results.get(pid) or {}).get("status") == "success")
print(f"\nSELESAI: {ok_n}/{len(ITEMS)} berhasil -> {OUT}", flush=True)
if hasil_media["images"] or hasil_media["videos"]:
    mb = hasil_media["bytes"] / (1024 * 1024)
    print(f"MEDIA: {hasil_media['images']} gambar + {hasil_media['videos']} video ({mb:.1f} MB) -> assets/", flush=True)
    extract_media.rebuild_manifest()
write_detail_js(results)
