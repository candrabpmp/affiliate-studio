#!/usr/bin/env python3
"""Bikin bundel deploy untuk VPS dari folder proyek ini.

Kenapa dipisah dari repo
------------------------
Repo publik tidak memuat data/ (berisi database + API key) dan assets/
(55 MB media). Tapi VPS butuh keduanya supaya aplikasi langsung ada isinya
saat dibuka juri. Jadi bundel dibuat lokal, diunggah sekali, lalu dibuang.

Kenapa tanpa folder staging
---------------------------
Versi pertama menyalin semua berkas ke _deploy/stage lebih dulu, lalu
membungkusnya. Itu berarti menulis 55 MB dua kali, dan setiap kali dibangun
ulang folder lama harus dihapus massal. Sekarang arsip disusun langsung dari
berkas sumber: lebih cepat, tidak ada sisa, tidak ada penghapusan massal.

Yang dilakukan skrip ini
------------------------
1. Menulis hanya berkas yang memang dipakai aplikasi (bukan seluruh folder).
2. Mengosongkan API key di dalam database — key tidak boleh ikut terbang.
3. Memaksa akhir baris LF untuk skrip, supaya bisa dijalankan di Linux.
4. Membungkusnya jadi satu .tar.gz.

Cara pakai
----------
    python scripts/paket_deploy.py
    # hasil: _deploy/affiliate-studio.tar.gz
"""
import io
import json
import os
import sqlite3
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "_deploy"
TARBALL = OUT_DIR / "affiliate-studio.tar.gz"
DB_TMP = OUT_DIR / ".db-bersih.tmp"

# Hanya berkas ini yang disajikan server (lihat STATIC_EXT di server.py).
FILES = [
    "index.html", "app.js", "agents.js", "detail.js",
    "rulebook.js", "pengaturan.js", "styles.css", "server.py",
]
# Folder yang ikut, beserta nama berkas yang dibuang.
DIRS = {
    "assets": [".media-none"],          # manifest + media produk
    "deploy": [],                        # Caddyfile, service, install.sh
}

# Ekstensi yang diperlakukan sebagai teks (lihat add_berkas()).
TEKS = {".sh", ".service", ".py", ".js", ".css", ".html", ".htm", ".md", ".json"}

ENV_CONTOH = (
    "# Dibaca systemd lewat EnvironmentFile. Jangan commit berkas ini.\n"
    "AFFILIATE_HOST=127.0.0.1\n"
    "AFFILIATE_PORT=8787\n"
    "AFFILIATE_ORIGIN=https://cpak.my.id,https://43-128-104-197.sslip.io\n"
    "PYTHONDONTWRITEBYTECODE=1\n"
)


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
         dengan grep pada berkas mentah (terukur: 63 kemunculan). Karena itu
         secure_delete + VACUUM.
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
        conn.execute("DELETE FROM snapshot")   # snapshot memuat salinan state lama
        conn.execute("VACUUM")
        return n
    finally:
        conn.close()


def add_bytes(tar, arcname, data, mode=0o644):
    info = tarfile.TarInfo(arcname)
    info.size = len(data)
    info.mode = mode
    info.mtime = int(time.time())
    tar.addfile(info, io.BytesIO(data))


def add_berkas(tar, src, arcname):
    """Tambahkan satu berkas ke arsip; berkas teks dipaksa berakhir LF.

    Di Windows, core.autocrlf bisa membuat skrip .sh ber-CRLF. Kalau itu ikut
    terkirim, VPS menolak menjalankannya dengan
    "/usr/bin/env: 'bash\\r': No such file or directory" — pesan yang tidak
    menunjukkan penyebab sebenarnya.
    """
    mode = 0o755 if src.suffix == ".sh" else 0o644
    if src.suffix.lower() in TEKS or src.name == "Caddyfile":
        add_bytes(tar, arcname, src.read_bytes().replace(b"\r\n", b"\n"), mode)
    else:
        tar.add(str(src), arcname=arcname)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("1/3 menyiapkan database (tanpa API key)")
    db_src = ROOT / "data" / "affiliate.db"
    ada_db = db_src.is_file()
    if ada_db:
        k = buat_db_bersih(str(db_src), str(DB_TMP))
        print("   %d API key dikosongkan + VACUUM (%.2f MB)"
              % (k, DB_TMP.stat().st_size / (1024 * 1024)))
    else:
        print("   ! data/affiliate.db tidak ada — VPS akan mulai dari kosong")

    print("2/3 menyusun arsip")
    n = 0
    with tarfile.open(TARBALL, "w:gz") as tar:
        for f in FILES:
            src = ROOT / f
            if src.is_file():
                add_berkas(tar, src, f)
                n += 1
            else:
                print("   ! lewat (tidak ada):", f)

        for name, skip in DIRS.items():
            base = ROOT / name
            if not base.is_dir():
                print("   ! folder tidak ada:", name)
                continue
            for p in sorted(base.rglob("*")):
                if p.is_file() and p.name not in skip:
                    # as_posix() wajib: str(Path) di Windows menghasilkan
                    # "deploy\Caddyfile", dan tar memperlakukannya sebagai SATU
                    # nama berkas berisi backslash — bukan direktori deploy/.
                    add_berkas(tar, p, p.relative_to(ROOT).as_posix())
                    n += 1

        if ada_db:
            add_berkas(tar, DB_TMP, "data/affiliate.db")
            n += 1

        add_bytes(tar, ".env", ENV_CONTOH.encode("utf-8"))

    print("3/3 beres")
    if DB_TMP.exists():
        DB_TMP.unlink()                   # satu berkas, aman

    mb = TARBALL.stat().st_size / (1024 * 1024)
    print("\nSelesai: %s (%.1f MB, %d berkas)" % (TARBALL, mb, n))
    print("Langkah berikut: bash deploy/deploy.sh affiliate-vps")
    return 0


if __name__ == "__main__":
    sys.exit(main())
