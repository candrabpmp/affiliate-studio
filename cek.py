#!/usr/bin/env python3
"""Cek isi database Affiliate Studio langsung dari file SQLite.

Dibaca read-only — skrip ini tidak mengubah apa pun. Berguna untuk memastikan
data benar-benar mendarat di database, bukan cuma di localStorage browser.

    python cek.py            ringkasan
    python cek.py --items    tambah daftar produk
    python cek.py --json     keluaran mentah (untuk disimpan/dibandingkan)
"""
import json
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "affiliate.db"


def human(ms):
    if not ms:
        return "—"
    return datetime.fromtimestamp(ms / 1000).strftime("%d/%m/%Y %H:%M:%S")


def baris(label, value):
    print(f"  {label:<22} {value}")


def main():
    if not DB.exists():
        print(f"Database belum ada: {DB}")
        print("Jalankan `python server.py` sekali — file database dibuat otomatis.")
        return 1

    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        ada = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('state','snapshot')"
        ).fetchall()
        if len(ada) < 2:
            print("Tabel belum dibuat. Jalankan `python server.py` sekali.")
            return 1

        row = conn.execute("SELECT rev, body, updated_at FROM state WHERE id = 1").fetchone()
        snaps = conn.execute(
            "SELECT rev, saved_at, bytes FROM snapshot ORDER BY rev DESC LIMIT 10"
        ).fetchall()
        total_snap = conn.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0]
    finally:
        conn.close()

    stat = DB.stat()
    print("DATABASE")
    baris("file", str(DB))
    baris("ukuran", f"{max(1, round(stat.st_size / 1024))} KB")
    baris("terakhir ditulis", human(stat.st_mtime * 1000))

    if not row:
        print("\nISI\n  (kosong — belum pernah ada yang disimpan)")
        return 0

    rev, body, updated_at = row
    try:
        state = json.loads(body)
    except Exception as e:
        print(f"\nISI\n  RUSAK: JSON tidak bisa dibaca ({e})")
        return 1

    items = state.get("items") or []
    aktif = [i for i in items if not i.get("archived")]
    arsip = len(items) - len(aktif)

    def plat(item, pf):
        return ((item.get("platforms") or {}).get(pf) or {})

    def st(item, pf):
        return plat(item, pf).get("status") or "belum review"

    lolos = sum(1 for i in aktif for pf in ("threads", "tiktok") if st(i, pf) == "lolos")
    posting = sum(
        1 for i in aktif for pf in ("threads", "tiktok")
        if (plat(i, pf).get("sched") or {}).get("status") == "berhasil posting"
    )
    terjadwal = sum(
        1 for i in aktif for pf in ("threads", "tiktok")
        if (plat(i, pf).get("sched") or {}).get("at")
        and (plat(i, pf).get("sched") or {}).get("status") == "belum post"
    )
    punya_detail = sum(1 for i in aktif if i.get("detailStatus") == "ok")

    print("\nISI")
    baris("revisi", rev)
    baris("disimpan", human(updated_at))
    baris("ukuran JSON", f"{len(body)} karakter")
    baris("produk aktif", f"{len(aktif)}" + (f" ({arsip} diarsipkan)" if arsip else ""))
    baris("punya detail", f"{punya_detail}/{len(aktif)}")
    baris("konten lolos", f"{lolos}/{len(aktif) * 2}")
    baris("terjadwal", terjadwal)
    baris("sudah diposting", posting)
    baris("log tersimpan", len(state.get("logs") or []))

    if len(sys.argv) > 1 and "--items" in sys.argv:
        print("\nPRODUK")
        for i in aktif[:40]:
            print(f"  · {str(i.get('name'))[:52]:<52} {st(i,'threads'):<13} {st(i,'tiktok')}")
        if len(aktif) > 40:
            print(f"  … {len(aktif) - 40} lagi")

    if snaps:
        print(f"\nSNAPSHOT ({total_snap} tersimpan, 10 terbaru)")
        for r, at, size in snaps:
            print(f"  rev {r:<5} {human(at)}  {size} karakter")
    else:
        print("\nSNAPSHOT\n  belum ada")

    if "--json" in sys.argv:
        print("\n" + json.dumps({"rev": rev, "updatedAt": updated_at, "state": state},
                                ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
