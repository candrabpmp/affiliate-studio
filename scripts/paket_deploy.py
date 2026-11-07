#!/usr/bin/env python3
"""Bikin bundel deploy untuk VPS dari folder proyek ini.

Kenapa dipisah dari repo
------------------------
Repo publik tidak memuat data/ (berisi database + API key) dan assets/
(55 MB media). Tapi VPS butuh keduanya supaya aplikasi langsung ada isinya
saat dibuka juri. Jadi bundel dibuat lokal, diunggah sekali, lalu dibuang.

Yang dilakukan skrip ini
------------------------
1. Menyalin hanya berkas yang memang dipakai aplikasi (bukan seluruh folder).
2. Mengosongkan API key di dalam database — key tidak boleh ikut terbang.
3. Menaruh Caddyfile, unit systemd, dan install.sh di dalam bundel.
4. Membungkusnya jadi satu .tar.gz.

Cara pakai
----------
    python scripts/paket_deploy.py
    # hasil: _deploy/affiliate-studio.tar.gz
"""
import json
import shutil
import sqlite3
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "_deploy"
STAGE = OUT_DIR / "stage"
TARBALL = OUT_DIR / "affiliate-studio.tar.gz"

# Hanya berkas ini yang disajikan server (lihat STATIC_EXT di server.py).
FILES = [
    "index.html", "app.js", "agents.js", "detail.js",
    "rulebook.js", "pengaturan.js", "styles.css", "server.py",
]
# Folder yang ikut, beserta pola yang dibuang.
DIRS = {
    "assets": [".media-none"],          # manifest + media produk
    "deploy": [],                        # Caddyfile, service, install.sh
}


def _kosongkan_key(node):
    """Kosongkan setiap nilai bernama 'key' di dalam node. Rekursif.

    Hanya dipanggil pada state['ai'] — jangan pada seluruh state, karena
    item produk juga punya field 'key' yang berisi identitas produk dan harus
    tetap utuh.
    """
    n = 0
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "key" and isinstance(v, str) and v:
                node[k] = ""
                n += 1
            else:
                n += _kosongkan_key(v)
    elif isinstance(node, list):
        for v in node:
            n += _kosongkan_key(v)
    return n


def buat_db_bersih(src, dst):
    """Salin database lalu hapus API key sampai benar-benar tidak tersisa.

    Dua jebakan yang dihindari di sini:
      1. shutil.copy2 pada .db bisa menghasilkan salinan tanpa isi WAL, jadi
         dipakai backup API SQLite yang selalu konsisten.
      2. Mengosongkan kolom saja tidak cukup — SQLite menandai halaman lama
         sebagai bebas tanpa menghapus isinya, sehingga key masih bisa dibaca
         dengan grep pada berkas mentah. Karena itu secure_delete + VACUUM.
    """
    src_conn = sqlite3.connect("file:%s?mode=ro" % src, uri=True)
    dst_conn = sqlite3.connect(dst)
    try:
        src_conn.backup(dst_conn)
    finally:
        src_conn.close()
        dst_conn.close()

    conn = sqlite3.connect(dst)
    conn.isolation_level = None          # autocommit; VACUUM tidak boleh dalam transaksi
    try:
        conn.execute("PRAGMA secure_delete=ON")
        row = conn.execute("SELECT body FROM state WHERE id = 1").fetchone()
        n = 0
        if row:
            state = json.loads(row[0])
            n = _kosongkan_key(state.get("ai") or {})
            conn.execute("UPDATE state SET body = ? WHERE id = 1",
                         (json.dumps(state, ensure_ascii=False),))
        # snapshot menyimpan salinan state lama — ikut memuat key.
        conn.execute("DELETE FROM snapshot")
        conn.execute("VACUUM")
        return n
    finally:
        conn.close()


def copy_file(rel, dest_root):
    src = ROOT / rel
    if not src.is_file():
        print("  ! lewat (tidak ada):", rel)
        return False
    dest = dest_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return True


def main():
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)

    print("1/5 menyalin berkas aplikasi")
    n = 0
    for f in FILES:
        n += copy_file(f, STAGE)
    print("   %d berkas" % n)

    print("2/5 menyalin assets/")
    total = 0
    for name, skip in DIRS.items():
        src_dir = ROOT / name
        if not src_dir.is_dir():
            print("   ! folder tidak ada:", name)
            continue
        for f in src_dir.rglob("*"):
            if not f.is_file():
                continue
            if f.name in skip:
                continue
            rel = f.relative_to(ROOT)
            dest = STAGE / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            total += 1
    print("   %d berkas" % total)

    print("3/5 menyiapkan database (tanpa API key)")
    db_src = ROOT / "data" / "affiliate.db"
    if db_src.is_file():
        (STAGE / "data").mkdir(parents=True, exist_ok=True)
        k = buat_db_bersih(str(db_src), str(STAGE / "data" / "affiliate.db"))
        print("   database disalin, %d API key dikosongkan + VACUUM" % k)
    else:
        print("   ! data/affiliate.db tidak ada — VPS akan mulai dari kosong")

    print("4/5 menulis .env contoh")
    (STAGE / ".env").write_text(
        "# Dibaca systemd lewat EnvironmentFile. Jangan commit berkas ini.\n"
        "AFFILIATE_HOST=127.0.0.1\n"
        "AFFILIATE_PORT=8787\n"
        "AFFILIATE_ORIGIN=https://43-128-104-197.sslip.io\n"
        "PYTHONDONTWRITEBYTECODE=1\n",
        encoding="utf-8",
    )

    print("5/5 membungkus tar.gz")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tarfile.open(TARBALL, "w:gz") as tar:
        # Hanya berkas. Kalau direktori ikut di-add, isinya masuk lewat rekursi
        # tar DAN lewat putaran berikutnya — berkas jadi berlipat di dalam arsip.
        for f in sorted(STAGE.rglob("*")):
            if f.is_file():
                tar.add(f, arcname=str(f.relative_to(STAGE)))
    mb = TARBALL.stat().st_size / (1024 * 1024)
    print("\nSelesai: %s (%.1f MB)" % (TARBALL, mb))
    print("Langkah berikut: bash deploy/deploy.sh root@43.128.104.197")
    return 0


if __name__ == "__main__":
    sys.exit(main())
