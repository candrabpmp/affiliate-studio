#!/usr/bin/env python3
"""Pindahkan database Affiliate Studio ke PostgreSQL di VPS.

Membaca _deploy/pg-server.txt lalu mengerjakan seluruh urutannya di VPS:

  1. memasang driver psycopg2 kalau belum ada
  2. membuat role + database sesuai isi txt (kalau belum ada)
  3. menghentikan layanan, menyalin SQLite -> PostgreSQL, memverifikasi isinya
  4. hanya kalau verifikasi lolos: menulis AFFILIATE_PG ke .env dan menyalakan
     layanan lagi

    python scripts/set-pg.py            # pasang + migrasi + aktifkan
    python scripts/set-pg.py --cek      # periksa yang sedang terpasang
    python scripts/set-pg.py --hapus    # kembali ke SQLite
    python scripts/set-pg.py --paksa    # timpa PostgreSQL dengan isi SQLite

Menjalankan berkas ini berulang aman — itu cara mengganti sandi. Kalau
PostgreSQL sudah berisi dan tidak ketinggalan dari SQLite, migrasi dilewati
(tidak ada yang perlu disalin, dan menyalin ulang berarti menimpa data yang
lebih baru dengan yang lama). `--paksa` untuk memaksa sebaliknya.

Sandi tidak pernah dicetak dan tidak pernah muncul di daftar proses: DSN
dikirim ke skrip migrasi lewat stdin. Kalau PASSWORD di txt kosong, skrip
membuatkan sandi acak dan menuliskannya kembali ke txt.
"""
import base64
import json
import re
import secrets
import string
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / "_deploy" / "pg-server.txt"
MIGRASI = ROOT / "scripts" / "migrasi_pg.py"
SSH_KEY = Path.home() / ".ssh" / "id_ed25519_deploy"
HOST = "ubuntu@43.128.104.197"
PUBLIC = "https://cpak.my.id"
ENV_PATH = "/opt/affiliate-studio/.env"
REMOTE_DB = "/opt/affiliate-studio/data/affiliate.db"
REMOTE_MIGRASI = "/tmp/migrasi_pg.py"

SSH = ["ssh", "-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=no", HOST]
SCP = ["scp", "-q", "-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=no"]


def _run(args, **kw):
    """subprocess.run dengan pesan yang berguna kalau programnya tidak ada.

    Di Windows, ssh/scp bisa tidak ada di PATH (OpenSSH Client belum dipasang,
    atau skrip dijalankan dari terminal yang tidak mewarisi PATH Git). Tanpa
    penanganan ini, pengguna hanya melihat FileNotFoundError [WinError 2] tanpa
    tahu apa yang hilang.
    """
    try:
        return subprocess.run(args, capture_output=True, text=True, **kw)
    except FileNotFoundError:
        raise SystemExit(
            "program %r tidak ditemukan di PATH.\n"
            "Di Windows: pasang 'OpenSSH Client' (Settings > Apps > Optional Features)\n"
            "atau jalankan skrip ini dari Git Bash." % args[0])


def sh(args, **kw):
    r = _run(args, **kw)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "").strip()
        raise SystemExit("perintah gagal: %s\n%s" % (" ".join(args[:3]), msg))
    return r.stdout


def ssh_teks(perintah, masukan=None):
    """Jalankan perintah di VPS; kembalikan (kode, stdout+stderr)."""
    r = _run(SSH + [perintah], input=masukan)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


# --------------------------------------------------------------- berkas txt
def baca_txt():
    if not TXT.exists():
        raise SystemExit("tidak ada %s" % TXT)
    nilai = {}
    for baris in TXT.read_text(encoding="utf-8").splitlines():
        b = baris.strip()
        if not b or b.startswith("#") or "=" not in b:
            continue
        k, v = b.split("=", 1)
        nilai[k.strip()] = v.strip()
    return nilai


def simpan_kunci(nama, sandi):
    """Tulis balik PASSWORD/…= ke txt, sisanya dibiarkan apa adanya."""
    baris = TXT.read_text(encoding="utf-8").splitlines()
    for i, b in enumerate(baris):
        if b.strip().startswith(nama + "="):
            baris[i] = "%s=%s" % (nama, sandi)
            break
    else:
        baris.append("%s=%s" % (nama, sandi))
    TXT.write_text("\n".join(baris) + "\n", encoding="utf-8")


def sandi_acak(n=28):
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(n))


# ------------------------------------------------------------------- .env VPS
def baca_env_lama():
    raw = sh(SSH + ["sudo cat %s | base64 -w0" % ENV_PATH])
    teks = base64.b64decode(raw.strip()).decode("utf-8", "replace")
    simpan = []
    for baris in teks.splitlines():
        if re.match(r"^\s*(AFFILIATE_PG|DATABASE_URL)\s*=", baris):
            continue
        simpan.append(baris)
    return "\n".join(simpan).strip()


def tulis_env(isi):
    tmp = ROOT / "_deploy" / ".env.pg"
    tmp.write_text(isi, encoding="utf-8", newline="\n")
    try:
        sh(SCP + [str(tmp), HOST + ":/tmp/affiliate.env"])
    finally:
        tmp.unlink(missing_ok=True)
    sh(SSH + [
        "sudo install -m 600 -o root -g root /tmp/affiliate.env %s && rm -f /tmp/affiliate.env" % ENV_PATH
    ])


# ------------------------------------------------------------------ PostgreSQL
def pastikan_driver():
    kode, keluar = ssh_teks(
        "python3 -c 'import psycopg2' >/dev/null 2>&1 && echo ADA || echo TIDAK")
    if "ADA" in keluar:
        return
    print("driver psycopg2 belum ada — memasang…")
    kode, keluar = ssh_teks("sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-psycopg2")
    if kode != 0:
        print("gagal memasang; mencoba memperbarui daftar paket dulu…")
        ssh_teks("sudo apt-get update -q")
        kode, keluar = ssh_teks("sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-psycopg2")
        if kode != 0:
            raise SystemExit("python3-psycopg2 gagal dipasang:\n" + keluar[-800:])


def cek_ident(nilai, pola, nama):
    if not re.match(pola, nilai):
        raise SystemExit("%s tidak valid: %r (hanya huruf/angka/_ , maks 30)" % (nama, nilai))
    return nilai


def pasang_role(n):
    db = cek_ident(n["DATABASE"], r"^[A-Za-z_][A-Za-z0-9_]{0,30}$", "DATABASE")
    user = cek_ident(n["USER"], r"^[A-Za-z_][A-Za-z0-9_]{0,30}$", "USER")
    pw = n["PASSWORD"]
    if not re.match(r"^[A-Za-z0-9._-]{12,64}$", pw):
        raise SystemExit("PASSWORD harus 12-64 karakter, tanpa tanda kutip/spasi/#")

    sql = [
        "DO $$ BEGIN "
        "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN "
        "CREATE ROLE %s LOGIN; END IF; END $$;" % (user, user),
        "ALTER ROLE %s WITH LOGIN PASSWORD '%s';" % (user, pw),
        "SELECT 'CREATE DATABASE %s OWNER %s' WHERE NOT EXISTS "
        "(SELECT 1 FROM pg_database WHERE datname = '%s')\\gexec" % (db, user, db),
        "GRANT ALL PRIVILEGES ON DATABASE %s TO %s;" % (db, user),
    ]
    super_pw = (n.get("SUPERUSER_PASSWORD") or "").strip()
    if super_pw:
        if not re.match(r"^[A-Za-z0-9._-]{12,64}$", super_pw):
            raise SystemExit("SUPERUSER_PASSWORD harus 12-64 karakter tanpa tanda kutip/spasi")
        sql.append("ALTER ROLE postgres WITH PASSWORD '%s';" % super_pw)

    kode, keluar = ssh_teks("sudo -u postgres psql -v ON_ERROR_STOP=1 -q -f -",
                            masukan="\n".join(sql) + "\n")
    if kode != 0:
        raise SystemExit("psql menolak perintah:\n" + keluar[-800:])
    print("role/database siap: %s@%s" % (user, db))
    return super_pw != ""


def jalankan_py(program, args=(), masukan="", pengguna=""):
    """Unggah program bantu ke /tmp lalu jalankan di VPS.

    Dipakai supaya sandi tidak pernah muncul di daftar proses dan tidak perlu
    melewati lapisan tanda kutip shell. `pengguna` penting untuk SQLite:
    membuka berkas .db butuh izin tulis di foldernya (untuk -wal/-shm), dan
    folder data/ hanya boleh ditulis user `affiliate`.
    """
    nama = "/tmp/_aff_%08x.py" % (abs(hash(program)) % 0xFFFFFFFF)
    r = _run(SSH + ["cat > " + nama], input=program)
    if r.returncode != 0:
        raise SystemExit("gagal mengunggah skrip bantu: " + (r.stderr or "")[-300:])
    awalan = ("sudo -u %s " % pengguna) if pengguna else ""
    return _run(SSH + [awalan + " ".join(["python3", nama] + list(args))], input=masukan)


def uji_koneksi(dsn):
    """Sambung dari VPS dengan kredensial aplikasi. DSN dikirim lewat stdin."""
    prog = r'''
import sys, psycopg2
dsn = sys.stdin.read().strip()
c = psycopg2.connect(dsn, connect_timeout=10)
cur = c.cursor()
cur.execute("select current_database(), current_user, version()")
db, us, ver = cur.fetchone()
cur.execute("select to_regclass('public.state') is not null")
ada = cur.fetchone()[0]
rev = 0
if ada:
    cur.execute("select rev from state where id = 1")
    r = cur.fetchone()
    rev = r[0] if r else 0
print("%s|%s|%s|%d|%d" % (db, us, ver.split()[1], 1 if ada else 0, rev))
'''
    r = jalankan_py(prog, masukan=dsn)
    if r.returncode != 0:
        raise SystemExit("koneksi PostgreSQL dengan kredensial aplikasi gagal:\n" + (r.stderr or "")[-600:])
    bagian = (r.stdout or "").strip().split("|")
    if len(bagian) < 5:
        raise SystemExit("balasan pemeriksa tidak dikenal: %r" % (r.stdout or "")[:200])
    return {
        "database": bagian[0], "user": bagian[1], "versi": bagian[2],
        "ada_tabel": bagian[3] == "1", "rev": int(bagian[4]),
    }


def restart():
    """Nyalakan ulang layanan; kembalikan True kalau benar-benar aktif."""
    sh(SSH + ["sudo systemctl restart affiliate-studio"])
    status = sh(SSH + ["systemctl is-active affiliate-studio"]).strip()
    print("layanan:", status)
    return status == "active"


def restart_atau_batal(env_lama):
    """Kalau layanan tidak hidup dengan PostgreSQL, kembalikan .env lama.

    Lebih baik kembali ke SQLite yang terbukti jalan daripada meninggalkan
    situs mati hanya karena percobaan pindah database.
    """
    if restart():
        return
    kode, log = ssh_teks("journalctl -u affiliate-studio -n 15 --no-pager")
    print(log.strip())
    tulis_env(env_lama)
    print("! .env dikembalikan ke konfigurasi lama (SQLite) — mencoba menyalakan lagi…")
    restart()
    raise SystemExit("gagal memakai PostgreSQL. Aplikasi kembali ke SQLite.")


def health():
    with urllib.request.urlopen(PUBLIC + "/api/health", timeout=20) as r:
        return json.load(r)


def rev_sqlite():
    prog = r'''
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
r = c.execute("select rev from state where id = 1").fetchone()
print(r[0] if r else 0)
'''
    r = jalankan_py(prog, args=[REMOTE_DB], pengguna="affiliate")
    if r.returncode != 0:
        raise SystemExit("gagal membaca revisi SQLite: " + (r.stderr or "")[-300:])
    return int((r.stdout or "0").strip() or 0)


# --------------------------------------------------------------------- alur
def buat_dsn(n):
    user = quote(n["USER"], safe="")
    pw = quote(n["PASSWORD"], safe="")
    host = n.get("HOST") or "127.0.0.1"
    port = n.get("PORT") or "5432"
    db = n["DATABASE"]
    return "postgresql://%s:%s@%s:%s/%s" % (user, pw, host, port, db)


def pasang(paksa=False):
    n = baca_txt()
    for wajib in ("DATABASE", "USER"):
        if not (n.get(wajib) or "").strip():
            raise SystemExit("%s belum diisi di %s" % (wajib, TXT))

    pw = (n.get("PASSWORD") or "").strip()
    if not pw:
        pw = sandi_acak()
        n["PASSWORD"] = pw
        simpan_kunci("PASSWORD", pw)
        print("PASSWORD kosong — dibuat sandi acak dan ditulis ke", TXT.name)

    print("host     :", n.get("HOST") or "127.0.0.1", "port", n.get("PORT") or "5432")
    print("database :", n["DATABASE"])
    print("user     :", n["USER"])
    print("password : %d karakter (tidak dicetak)" % len(pw))

    pastikan_driver()
    ada_super = pasang_role(n)

    dsn = buat_dsn(n)
    info = uji_koneksi(dsn)
    print("tersambung: %s@%s · PostgreSQL %s" % (info["user"], info["database"], info["versi"]))
    if ada_super:
        print("sandi user postgres juga diperbarui")

    env_lama = baca_env_lama()
    rev_lama = rev_sqlite()

    # Menjalankan skrip ini dua kali adalah hal wajar — biasanya untuk mengganti
    # sandi. Kalau PostgreSQL sudah berisi dan tidak ketinggalan dari SQLite,
    # menyalin ulang berarti menimpa data yang lebih baru dengan yang lama.
    # Jadi migrasi dilewati, bukan digagalkan.
    lewati = info["ada_tabel"] and info["rev"] > 0 and info["rev"] >= rev_lama and not paksa
    if lewati:
        print("\nPostgreSQL sudah berisi revisi %d; SQLite %d — migrasi dilewati."
              % (info["rev"], rev_lama))
        target = info["rev"]
        tulis_env(env_lama + "\n\n# --- database (dipasang oleh scripts/set-pg.py) ---\n"
                  + "AFFILIATE_PG=%s\n" % dsn)
        print(".env VPS: AFFILIATE_PG ditulis")
    else:
        # --- migrasi: layanan dihentikan dulu supaya tidak ada tulisan di tengah jalan
        print("\nmenghentikan layanan…")
        sh(SSH + ["sudo systemctl stop affiliate-studio"])
        try:
            sh(SCP + [str(MIGRASI), HOST + ":" + REMOTE_MIGRASI])
            # -u affiliate: folder data/ hanya bisa ditulis user itu, dan SQLite
            # butuh izin tulis di folder untuk berkas -wal/-shm.
            r = _run(
                SSH + ["sudo -u affiliate python3 %s --sqlite %s --dsn -" % (REMOTE_MIGRASI, REMOTE_DB)],
                input=dsn)
            print((r.stdout or "").strip())
            if r.returncode != 0:
                print((r.stderr or "").strip())
                raise SystemExit("migrasi gagal — .env tidak diubah, layanan tetap memakai SQLite")
            target = rev_sqlite()

            isi = env_lama + "\n\n# --- database (dipasang oleh scripts/set-pg.py) ---\n"
            isi += "AFFILIATE_PG=%s\n" % dsn
            tulis_env(isi)
            print(".env VPS: AFFILIATE_PG ditulis")
        except BaseException:
            # apa pun yang terjadi, layanan harus hidup lagi dengan konfigurasi lama
            sh(SSH + ["sudo systemctl start affiliate-studio"])
            raise

    restart_atau_batal(env_lama)

    h = health()
    print("health  :", json.dumps(h, ensure_ascii=False))
    if h.get("store") != "postgres":
        raise SystemExit("server masih melaporkan store=%r — periksa .env" % h.get("store"))
    if h.get("rev") != target:
        raise SystemExit("revisi tidak cocok: postgres=%s sqlite=%s" % (h.get("rev"), target))
    if lewati:
        print("\nSelesai. Aplikasi memakai PostgreSQL revisi %d. Tidak ada data yang disalin."
              % target)
        print("Berkas SQLite (revisi %d) dibiarkan apa adanya — itu cadangan lama, bukan salinan terkini."
              % rev_lama)
    else:
        print("\nSelesai. Aplikasi memakai PostgreSQL, revisi %d, isi sama dengan SQLite." % target)
        print("Berkas SQLite TIDAK dihapus — masih jadi cadangan. Hapus manual kalau sudah yakin.")


def cek():
    kode, isi = ssh_teks("sudo grep -h '^AFFILIATE_PG=' %s || true" % ENV_PATH)
    dsn = isi.strip().split("=", 1)[1] if "=" in isi else ""
    if not dsn:
        print("AFFILIATE_PG belum dipasang — aplikasi memakai SQLite.")
        print("health:", json.dumps(health(), ensure_ascii=False))
        return
    info = uji_koneksi(dsn)
    print("postgres: %s@%s · versi %s · tabel state %s · rev %d" % (
        info["user"], info["database"], info["versi"],
        "ada" if info["ada_tabel"] else "BELUM ADA", info["rev"]))
    print("health  :", json.dumps(health(), ensure_ascii=False))


def hapus():
    tulis_env(baca_env_lama() + "\n")
    if not restart():
        raise SystemExit("layanan tidak aktif setelah AFFILIATE_PG dihapus — periksa journalctl")
    print("AFFILIATE_PG dihapus. Aplikasi kembali memakai SQLite.")
    print("health:", json.dumps(health(), ensure_ascii=False))


def main():
    arg = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    if arg == "--cek":
        return cek()
    if arg == "--hapus":
        return hapus()
    if arg in ("-h", "--help"):
        print(__doc__)
        return
    pasang(paksa=(arg == "--paksa"))


if __name__ == "__main__":
    main()
