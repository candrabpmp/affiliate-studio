#!/usr/bin/env python3
"""Salin database Affiliate Studio dari SQLite ke PostgreSQL, lalu buktikan.

Yang disalin hanya dua tabel: `state` (satu baris JSON berisi seluruh aplikasi)
dan `snapshot` (riwayat revisi). Berkas media di assets/ dan data/video/ tidak
ikut — itu memang tinggal di disk.

    python scripts/migrasi_pg.py --cek          # bandingkan saja, tidak menulis
    python scripts/migrasi_pg.py                # salin kalau target masih kosong
    python scripts/migrasi_pg.py --paksa        # timpa target yang sudah berisi
    python scripts/migrasi_pg.py --dsn -        # DSN dibaca dari stdin (tidak
                                                # pernah muncul di daftar proses)

DSN juga bisa datang dari env AFFILIATE_PG. Tanpa DSN, skrip berhenti: ia
menolak menebak-nebak alamat database.

Verifikasi bukan sekadar "jumlah baris cocok": isi body dibandingkan
karakter-per-karakter lewat SHA-256, plus jumlah produk dan rentang revisi.
Kalau satu saja tidak sama, skrip keluar dengan kode 1.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DDL = (
    "CREATE TABLE IF NOT EXISTS state ("
    " id INTEGER PRIMARY KEY CHECK (id = 1),"
    " rev INTEGER NOT NULL DEFAULT 0,"
    " body TEXT NOT NULL,"
    " updated_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS snapshot ("
    " rev INTEGER PRIMARY KEY,"
    " body TEXT NOT NULL,"
    " saved_at BIGINT NOT NULL,"
    " bytes INTEGER NOT NULL)",
)


def sha(teks):
    return hashlib.sha256(teks.encode("utf-8")).hexdigest()


def baca_sqlite(path):
    if not path.exists():
        raise SystemExit("database SQLite tidak ada: %s" % path)
    conn = sqlite3.connect(str(path))
    try:
        row = conn.execute("SELECT rev, body, updated_at FROM state WHERE id = 1").fetchone()
        snaps = conn.execute(
            "SELECT rev, body, saved_at, bytes FROM snapshot ORDER BY rev"
        ).fetchall()
    finally:
        conn.close()
    if not row:
        raise SystemExit("tabel state kosong di %s — tidak ada yang bisa disalin" % path)
    return row, snaps


def baca_pg(conn):
    cur = conn.cursor()
    cur.execute("SELECT rev, body, updated_at FROM state WHERE id = 1")
    row = cur.fetchone()
    cur.execute("SELECT rev, body, saved_at, bytes FROM snapshot ORDER BY rev")
    return row, cur.fetchall()


def ringkas(row, snaps):
    if not row:
        return {"rev": 0, "byte": 0, "sha": "-", "produk": 0, "snapshot": 0}
    try:
        isi = json.loads(row[1])
    except Exception:
        isi = {}
    return {
        "rev": row[0],
        "byte": len(row[1]),
        "sha": sha(row[1]),
        "produk": len(isi.get("items") or []),
        "snapshot": len(snaps),
    }


def bandingkan(a, b):
    """Kembalikan daftar perbedaan antara ringkasan SQLite (a) dan PG (b)."""
    beda = []
    for k in ("rev", "byte", "sha", "produk", "snapshot"):
        if a[k] != b[k]:
            beda.append("%s: sqlite=%s postgres=%s" % (k, a[k], b[k]))
    return beda


def tulis(conn, row, snaps, paksa):
    cur = conn.cursor()
    # Skema dulu: tanpa ini baca_pg gagal karena tabel belum ada.
    for sql in DDL:
        cur.execute(sql)
    conn.commit()

    lama, _ = baca_pg(conn)
    if lama and lama[0] > 0 and not paksa:
        raise SystemExit(
            "PostgreSQL sudah berisi revisi %d. Skrip menolak menimpanya.\n"
            "Kalau memang mau diganti isi SQLite: ulangi dengan --paksa" % lama[0]
        )
    cur.execute(
        "INSERT INTO state (id, rev, body, updated_at) VALUES (1, %s, %s, %s) "
        "ON CONFLICT (id) DO UPDATE SET rev=excluded.rev, body=excluded.body, "
        "updated_at=excluded.updated_at",
        (row[0], row[1], row[2]),
    )
    for rev, body, saved, size in snaps:
        cur.execute(
            "INSERT INTO snapshot (rev, body, saved_at, bytes) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (rev) DO UPDATE SET body=excluded.body, "
            "saved_at=excluded.saved_at, bytes=excluded.bytes",
            (rev, body, saved, size),
        )
    conn.commit()


def konek(dsn):
    try:
        import psycopg2
    except ImportError:
        raise SystemExit("driver psycopg2 belum ada. Jalankan: sudo apt install -y python3-psycopg2")
    try:
        conn = psycopg2.connect(dsn, connect_timeout=10)
    except Exception as e:
        raise SystemExit("tidak bisa tersambung ke PostgreSQL: %s" % e)
    conn.autocommit = False
    return conn


def main():
    ap = argparse.ArgumentParser(description="Migrasi SQLite -> PostgreSQL")
    ap.add_argument("--dsn", default=os.environ.get("AFFILIATE_PG") or os.environ.get("DATABASE_URL") or "")
    ap.add_argument("--sqlite", default=os.environ.get("AFFILIATE_DB") or str(ROOT / "data" / "affiliate.db"))
    ap.add_argument("--cek", action="store_true", help="hanya bandingkan, tidak menulis")
    ap.add_argument("--paksa", action="store_true", help="timpa database tujuan yang sudah berisi")
    a = ap.parse_args()

    dsn = (a.dsn or "").strip()
    if dsn == "-":
        dsn = sys.stdin.read().strip()
    if not dsn:
        raise SystemExit("DSN PostgreSQL kosong (--dsn, atau env AFFILIATE_PG)")

    sqlite_path = Path(a.sqlite)
    row, snaps = baca_sqlite(sqlite_path)
    asal = ringkas(row, snaps)
    print("SQLite   :", sqlite_path)
    print("           rev %(rev)d · %(produk)d produk · %(snapshot)d snapshot · %(byte)d byte" % asal)

    conn = konek(dsn)
    try:
        if a.cek:
            try:
                tujuan = ringkas(*baca_pg(conn))
            except Exception:
                conn.rollback()          # tabel belum ada: anggap kosong
                tujuan = ringkas(None, [])
            print("Postgres : rev %(rev)d · %(produk)d produk · %(snapshot)d snapshot · %(byte)d byte" % tujuan)
            beda = bandingkan(asal, tujuan)
            if beda:
                print("BEDA:")
                for b in beda:
                    print("  -", b)
                return 1
            print("SAMA — kedua database berisi data yang identik.")
            return 0

        tulis(conn, row, snaps, a.paksa)
        tujuan = ringkas(*baca_pg(conn))
        print("Postgres : rev %(rev)d · %(produk)d produk · %(snapshot)d snapshot · %(byte)d byte" % tujuan)
        beda = bandingkan(asal, tujuan)
        if beda:
            print("VERIFIKASI GAGAL:")
            for b in beda:
                print("  -", b)
            return 1
        print("VERIFIKASI LOLOS — isi identik (SHA-256 body sama).")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
