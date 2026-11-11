#!/usr/bin/env python3
"""Server lokal Affiliate Studio — menyimpan data ke database, bukan ke browser.

Kenapa ini ada
--------------
localStorage terikat pada satu browser + satu origin. Buka di browser lain,
atau lewat port lain, datanya tidak ada. Server ini menyimpan state di satu
tempat (PostgreSQL di VPS, SQLite di mesin lokal), jadi semua browser membaca
sumber yang sama.

Penyimpanan
-----------
Bawaannya SQLite: satu file di data/affiliate.db, tanpa paket tambahan.
Kalau AFFILIATE_PG diisi DSN PostgreSQL, server memakai PostgreSQL:

    AFFILIATE_PG=postgresql://affiliate:rahasia@127.0.0.1:5432/affiliate_studio

Butuh driver psycopg2 di mesin itu (sudo apt install -y python3-psycopg2).
Pindah isi database lama dengan scripts/migrasi_pg.py.

Cara pakai
----------
    python server.py
    buka http://127.0.0.1:8787/

Tanpa argumen lain. Hanya mendengarkan di 127.0.0.1 (tidak terekspos ke
jaringan).

API
---
GET  /api/state            -> { rev, updatedAt, bytes, state }
GET  /api/state?rev=N      -> snapshot revisi tertentu
PUT  /api/state            -> body {"state": {...}} ; simpan + snapshot
GET  /api/history?limit=20 -> daftar snapshot (tanpa isi)
GET  /api/health           -> { ok, store, rev }
POST /api/extract          -> mulai ekstraksi detail (proses terpisah)
GET  /api/extract          -> status/progres ekstraksi
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
# AFFILIATE_DB bisa menunjuk file lain — dipakai untuk uji coba supaya database
# asli tidak pernah tersentuh.
DB_PATH = Path(os.environ.get("AFFILIATE_DB") or (ROOT / "data" / "affiliate.db"))

# ---------------------------------------------------------------- penyimpanan
# PostgreSQL dipakai di VPS; SQLite tetap jadi bawaan supaya pengembangan di
# mesin tanpa server database (dan semua skrip uji di _uji/) tetap jalan.
# DSN dibaca sekali di awal: mengubahnya butuh restart layanan.
PG_DSN = (os.environ.get("AFFILIATE_PG") or os.environ.get("DATABASE_URL") or "").strip()
STORE = "postgres" if PG_DSN else "sqlite"

# Di localhost cukup 127.0.0.1. Di VPS server tetap di loopback dan Caddy yang
# menghadap internet, jadi default ini sengaja TIDAK diubah menjadi 0.0.0.0.
# Kalau benar-benar perlu mendengarkan langsung tanpa reverse proxy, set
# AFFILIATE_HOST=0.0.0.0 — tapi itu membuka port mentah ke internet.
HOST = os.environ.get("AFFILIATE_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ.get("AFFILIATE_PORT", "8787"))

# Video hasil generator (Veo/Gemini/Kling) TIDAK disimpan di SQLite. Database-nya
# cuma satu baris JSON state yang ditulis ulang tiap perubahan — menaruh file
# 5 MB di dalamnya berarti menyalin 5 MB setiap kali user mengetik. Jadi file
# ditaruh di disk (data/video/<key produk>/<timestamp>.mp4) dan state hanya
# menyimpan nama file + metadata.
# VIDEO_DIR bisa diarahkan lewat env supaya uji coba tidak mengotori data asli.
VIDEO_DIR = Path(os.environ.get("AFFILIATE_VIDEO_DIR") or (ROOT / "data" / "video"))
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
VIDEO_MAX = 200 * 1024 * 1024          # 200 MB per file

# berapa snapshot yang disimpan sebagai jaring pengaman
MAX_SNAPSHOTS = 60
# jarak minimum antar snapshot otomatis (detik) — supaya tidak banjir saat mengetik
SNAPSHOT_EVERY = 120

_lock = threading.Lock()

# ---------------------------------------------------------------- CORS
# Di localhost semua port boleh (panel preview jalan di port lain). Di VPS,
# origin asli didaftarkan lewat AFFILIATE_ORIGIN (pisahkan dengan koma) supaya
# situs lain tidak bisa membaca data lewat browser pengunjung. Origin internet
# yang tidak terdaftar ditolak — bukan sekadar headernya tidak dikirim.
_ORIGIN_ALLOW = [o.strip().rstrip("/") for o in
                 (os.environ.get("AFFILIATE_ORIGIN") or "").split(",") if o.strip()]
_LOCAL_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")


def origin_ok(origin):
    if not origin:
        return False
    return origin.rstrip("/") in _ORIGIN_ALLOW or bool(_LOCAL_ORIGIN.match(origin))


# ------------------------------------------------- berkas yang boleh keluar
# Dulu seluruh folder proyek disajikan apa adanya (SimpleHTTPRequestHandler
# dengan directory=ROOT). Di localhost itu tidak berbahaya; begitu server
# menghadap internet, artinya data/affiliate.db, .git/config, dan server.py
# sendiri bisa diunduh siapa pun yang tahu URL-nya. Jadi sekarang hanya berkas
# web yang lolos: daftar putih berdasarkan ekstensi, folder tersembunyi ditolak.
STATIC_EXT = {".html", ".htm", ".js", ".css", ".ico",
              ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"}


def static_ok(path):
    if not path or path == "/":
        return True
    for seg in path.split("/"):
        if seg.startswith("."):
            return False            # .git, .env, .workbuddy-ai, dsb.
    return Path(path).suffix.lower() in STATIC_EXT


# ------------------------------------------------------------ proksi LLM
# Kenapa key tidak boleh di browser
# ---------------------------------
# Aplikasi ini aslinya memanggil LLM langsung dari browser, dengan key yang
# disimpan di state. Di localhost itu wajar. Di VPS, key yang dikirim ke
# browser bisa dibaca siapa pun lewat DevTools — dan endpoint-nya bisa dipakai
# orang lain untuk menghabiskan kuota.
#
# Jadi di server: browser memanggil /api/llm/chat/completions tanpa key,
# server yang menyisipkan key ke permintaan ke atas. Bentuk permintaan dan
# balasan tetap OpenAI-compatible, sehingga kode klien tidak perlu diubah.
#
# Kalau LLM_UPSTREAM kosong, endpoint ini menjawab 503 dan aplikasi kembali
# memakai setelan pengguna seperti biasa (mode lokal tidak terpengaruh).
LLM_UPSTREAM = (os.environ.get("LLM_UPSTREAM") or "").strip().rstrip("/")
LLM_API_KEY = (os.environ.get("LLM_API_KEY") or "").strip()
LLM_MODEL = (os.environ.get("LLM_MODEL") or "").strip()
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "180"))
LLM_RATE = int(os.environ.get("LLM_RATE_PER_10MIN", "60"))   # per IP / 10 menit
# Model reasoning (deepseek-v4-flash, o-series, ds-r1) menghabiskan token untuk
# reasoning_content sebelum menulis jawaban. Dengan batas 8192, satu permintaan
# Writer bisa habis seluruhnya untuk berpikir: finish_reason "length", content
# kosong. Dua variabel ini menyuntikkan penyesuaian di sisi server supaya klien
# tidak perlu tahu model apa yang dipakai.
LLM_REASONING_EFFORT = (os.environ.get("LLM_REASONING_EFFORT") or "").strip()
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "0") or 0)

_llm_hits = {}
_llm_lock = threading.Lock()


def llm_allow(ip):
    """Batas laju sederhana per IP. Tanpa ini, satu orang bisa menghabiskan
    kuota LLM lewat halaman publik hanya dengan menekan Generate berulang."""
    now = time.time()
    with _llm_lock:
        arr = [t for t in (_llm_hits.get(ip) or []) if now - t < 600]
        if len(arr) >= LLM_RATE:
            _llm_hits[ip] = arr
            return False
        arr.append(now)
        _llm_hits[ip] = arr
        if len(_llm_hits) > 1000:                 # jangan tumbuh tanpa batas
            for k in [k for k, v in _llm_hits.items() if not v]:
                _llm_hits.pop(k, None)
        return True


_DDL = (
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

_siap = False
_siap_lock = threading.Lock()


def _q(sql):
    """SQLite memakai ?, psycopg2 memakai %s. Satu tempat untuk menerjemahkan."""
    return sql.replace("?", "%s") if STORE == "postgres" else sql


def _pg():
    """Koneksi baru ke PostgreSQL.

    Satu koneksi per permintaan: server ini ThreadingHTTPServer, dan koneksi
    psycopg2 tidak boleh dipakai bersama antar-thread. Biayanya satu handshake
    TCP di loopback — tidak terasa dibanding satu tulisan state 85 KB.
    """
    try:
        import psycopg2
    except ImportError:
        raise RuntimeError(
            "AFFILIATE_PG diisi tetapi driver psycopg2 tidak ada. "
            "Pasang dulu: sudo apt install -y python3-psycopg2"
        )
    return psycopg2.connect(PG_DSN, connect_timeout=10)


def _sql():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def db():
    """Koneksi ke backend yang aktif. Skema dipastikan sekali saja per proses."""
    global _siap
    conn = _pg() if STORE == "postgres" else _sql()
    if _siap:
        return conn
    with _siap_lock:
        if not _siap:
            try:
                cur = conn.cursor()
                for sql in _DDL:
                    cur.execute(sql)
                conn.commit()
                _siap = True
            except Exception:
                conn.close()
                raise
    return conn


def read_state(rev=None):
    conn = db()
    try:
        cur = conn.cursor()
        if rev is None:
            cur.execute("SELECT rev, body, updated_at FROM state WHERE id = 1")
            row = cur.fetchone()
            if not row:
                return {"rev": 0, "updatedAt": None, "bytes": 0, "state": None}
            return {"rev": row[0], "updatedAt": row[2], "bytes": len(row[1]), "state": json.loads(row[1])}
        cur.execute(_q("SELECT rev, body, saved_at FROM snapshot WHERE rev = ?"), (rev,))
        row = cur.fetchone()
        if not row:
            return None
        return {"rev": row[0], "updatedAt": row[2], "bytes": len(row[1]), "state": json.loads(row[1])}
    finally:
        conn.close()


def ai_key_slots(state):
    """Ambil semua ai.<provider>.key dari sebuah state."""
    out = {}
    ai = state.get("ai") if isinstance(state, dict) else None
    if isinstance(ai, dict):
        for name, cfg in ai.items():
            if isinstance(cfg, dict) and isinstance(cfg.get("key"), str):
                out[name] = cfg["key"]
    return out


def redact_ai_keys(state):
    """Kosongkan ai.*.key sebelum state dikirim ke klien non-lokal.

    Tanpa ini, siapa pun yang membuka /api/state bisa membaca API key yang
    tersimpan di database — cukup dengan curl, tanpa perlu membuka aplikasi.
    """
    ai = state.get("ai") if isinstance(state, dict) else None
    if isinstance(ai, dict):
        for cfg in ai.values():
            if isinstance(cfg, dict) and cfg.get("key"):
                cfg["key"] = ""
    return state


def restore_ai_keys(state, saved):
    """Kembalikan kunci lama ke state kiriman klien jarak jauh.

    Klien jarak jauh tidak pernah menerima kunci, jadi state yang dikirim
    baliknya berisi key kosong. Kalau ditulis apa adanya, satu klik "simpan"
    dari pengunjung akan menghapus kunci milik pemilik aplikasi.
    """
    ai = state.get("ai") if isinstance(state, dict) else None
    if not isinstance(ai, dict):
        return state
    for name, cfg in ai.items():
        if isinstance(cfg, dict):
            cfg["key"] = saved.get(name, "")
    return state


def write_state(body_text):
    """Simpan state baru. Mengembalikan (rev, bytes, snapshot_dibuat)."""
    conn = db()
    try:
        cur = conn.cursor()
        if STORE == "postgres":
            # psycopg2 membuka transaksi sendiri. Kunci barisnya supaya dua
            # penulisan bersamaan tidak mendapat nomor revisi yang sama.
            cur.execute("SELECT rev, body, updated_at FROM state WHERE id = 1 FOR UPDATE")
        else:
            conn.execute("BEGIN IMMEDIATE")
            cur.execute("SELECT rev, body, updated_at FROM state WHERE id = 1")
        row = cur.fetchone()
        rev = (row[0] if row else 0) + 1
        now = int(time.time() * 1000)

        # cadangkan isi lama sebelum ditimpa. Tiga snapshot pertama dibuat
        # selalu (supaya ada titik pulang sejak awal), sisanya dibatasi waktu.
        made = False
        if row:
            old_rev, old_body, old_at = row
            cur.execute("SELECT COUNT(*), MAX(saved_at) FROM snapshot")
            count, last_at = cur.fetchone()
            if count < 3 or not last_at or (now - last_at) >= SNAPSHOT_EVERY * 1000:
                cur.execute(
                    _q("INSERT INTO snapshot (rev, body, saved_at, bytes) VALUES (?,?,?,?) "
                       "ON CONFLICT (rev) DO UPDATE SET body=excluded.body, "
                       "saved_at=excluded.saved_at, bytes=excluded.bytes"),
                    (old_rev, old_body, old_at, len(old_body)),
                )
                made = True
                cur.execute(
                    _q("DELETE FROM snapshot WHERE rev NOT IN "
                       "(SELECT rev FROM snapshot ORDER BY rev DESC LIMIT ?)"),
                    (MAX_SNAPSHOTS,),
                )

        cur.execute(
            _q("INSERT INTO state (id, rev, body, updated_at) VALUES (1, ?, ?, ?) "
               "ON CONFLICT (id) DO UPDATE SET rev=excluded.rev, body=excluded.body, "
               "updated_at=excluded.updated_at"),
            (rev, body_text, now),
        )
        conn.commit()
        return rev, len(body_text), made
    finally:
        conn.close()


def history(limit=20):
    conn = db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM snapshot")
        total = cur.fetchone()[0]
        cur.execute(
            _q("SELECT rev, saved_at, bytes FROM snapshot ORDER BY rev DESC LIMIT ?"), (limit,)
        )
        rows = cur.fetchall()
        return total, [{"rev": r[0], "savedAt": r[1], "bytes": r[2]} for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------- ekstraksi
# Ekstraksi detail dijalankan sebagai proses terpisah dari aplikasi web, tapi
# dipicu dan dipantau lewat HTTP. Browser tidak bisa menjalankan proses sendiri;
# server inilah yang bisa. Jadi tombol di UI cukup memanggil endpoint ini.

_extract = {
    "status": "idle",      # idle | running | done | error
    "total": 0,
    "done": 0,
    "current": "",
    "log": [],
    "startedAt": None,
    "finishedAt": None,
    "error": "",
    "ok": 0,
    "failed": 0,
}
_extract_lock = threading.Lock()


# ---------------- status sumber detail produk ----------------
# Detail produk seharusnya datang dari Shopee Open API. Selama akun developer
# belum punya akses, satu-satunya jalan adalah membuka halaman produk dengan
# browser — dan itu tidak bisa dikerjakan dari mesin ini: IP VPS adalah IP
# datacenter, yang ditolak Shopee sebelum HTML halaman keluar. Ekstraktor yang
# dipakai juga bergantung pada Chrome desktop (lihat scripts/extract_batch.py).
#
# Jadi server tidak berpura-pura bisa. Kemampuannya dinyatakan lewat
# /api/extract, dan UI menampilkan keterangan — bukan pesan galat mentah.
SHOPEE_API_READY = os.environ.get("SHOPEE_API", "").strip().lower() in ("1", "true", "yes", "on")
EXTRACT_ENABLED = os.environ.get("SHOPEE_EXTRACT", "auto").strip().lower() not in ("0", "off", "false", "no")


def extract_capability():
    """Boleh tidak detail diambil dari server ini, dan alasannya."""
    if SHOPEE_API_READY:
        return {"available": True, "mode": "api", "reason": "",
                "note": "Detail diambil dari Shopee Open API."}
    if not EXTRACT_ENABLED:
        return {"available": False, "mode": "off", "reason": "dimatikan",
                "note": "Ekstraksi dimatikan lewat SHOPEE_EXTRACT=off."}
    if os.name != "nt":
        # Linux = VPS. Diperiksa sebelum keberadaan skrip: di sini skripnya pun
        # tidak dipasang, tapi sebab sebenarnya bukan itu — ekstraktor butuh
        # Chrome desktop dan IP non-datacenter, dan keduanya tidak ada.
        return {"available": False, "mode": "scrape", "reason": "ip datacenter",
                "note": "Server berjalan di IP datacenter; Shopee menolak halaman produk dari alamat itu."}
    if not (ROOT / "scripts" / "extract_batch.py").exists():
        return {"available": False, "mode": "scrape", "reason": "skrip tidak ada",
                "note": "scripts/extract_batch.py tidak ditemukan di server ini."}
    return {"available": True, "mode": "scrape", "reason": "",
            "note": "Ekstraksi lewat Chrome di mesin ini."}


def punya_media(pid):
    """True kalau folder assets/<pid>/ sudah berisi file (atau ditandai kosong)."""
    folder = ROOT / "assets" / str(pid)
    if not folder.is_dir():
        return False
    files = list(folder.iterdir())
    if any(f.name == ".media-none" for f in files):
        return True
    return any(not f.name.startswith(".") for f in files)


def pending_from_state():
    """Produk aktif yang masih butuh detail dan/atau media, diambil dari database.

    `need` membedakan dua pekerjaan supaya UI bisa menghitungnya terpisah:
      detail -> belum punya data produk, harus scraping penuh
      media  -> detail sudah ada, tinggal unduh gambar/video
    """
    items = (read_state().get("state") or {}).get("items") or []
    out = []
    for it in items:
        if it.get("archived"):
            continue
        pid = str(it.get("productId") or "").strip()
        if not pid:
            continue
        punya_detail = (it.get("detailStatus") or "") == "ok" or bool(it.get("detail"))
        if punya_detail and punya_media(pid):
            continue
        out.append({
            "id": pid,
            "url": it.get("productUrl") or ("https://shopee.co.id/product/" + pid),
            "need": "media" if punya_detail else "detail",
        })
    return out


def assets_manifest():
    """Daftar file di assets/<productId>/ — supaya UI tahu aset barunya."""
    img = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}
    vid = {".mp4", ".mov", ".webm", ".m4v", ".avi"}
    items = {}
    base = ROOT / "assets"
    if base.is_dir():
        for folder in sorted(base.iterdir()):
            if not folder.is_dir():
                continue
            files = []
            for f in sorted(folder.iterdir()):
                if not f.is_file() or f.name.startswith("."):
                    continue
                ext = f.suffix.lower()
                files.append({
                    "file": f.name,
                    "kind": "image" if ext in img else ("video" if ext in vid else "other"),
                    "bytes": f.stat().st_size,
                })
            if files:
                items[folder.name] = files
    return {"items": items}


def _extract_worker(items):
    global _extract
    script = ROOT / "scripts" / "extract_batch.py"
    try:
        (ROOT / "data").mkdir(parents=True, exist_ok=True)
        (ROOT / "data" / "pending.json").write_text(
            json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        proc = subprocess.Popen(
            [sys.executable, str(script)],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            with _extract_lock:
                _extract["log"].append(line)
                if len(_extract["log"]) > 400:
                    del _extract["log"][:-400]
                m = re.match(r"\[(\d+)/(\d+)\]\s*(.*)", line)
                if m:
                    _extract["done"] = max(0, int(m.group(1)) - 1)
                    _extract["total"] = int(m.group(2))
                    _extract["current"] = m.group(3)
                if "-> OK" in line or "SKIP" in line:
                    _extract["ok"] += 1
                elif "-> GAGAL" in line:
                    _extract["failed"] += 1
        code = proc.wait()
        with _extract_lock:
            _extract["finishedAt"] = int(time.time() * 1000)
            if code == 0:
                _extract["status"] = "done"
                _extract["done"] = _extract["total"]
            else:
                _extract["status"] = "error"
                _extract["error"] = "skrip keluar dengan kode %d — lihat log" % code
    except Exception as e:
        with _extract_lock:
            _extract["status"] = "error"
            _extract["error"] = str(e)
            _extract["finishedAt"] = int(time.time() * 1000)


def start_extract():
    """Mulai pekerjaan ekstraksi. Mengembalikan (ok, payload)."""
    global _extract
    items = pending_from_state()
    with _extract_lock:
        if _extract["status"] == "running":
            return False, dict(_extract)
        if not items:
            _extract.update({
                "status": "done", "total": 0, "done": 0, "current": "",
                "log": ["Tidak ada produk yang perlu diekstrak."],
                "startedAt": int(time.time() * 1000),
                "finishedAt": int(time.time() * 1000),
                "error": "", "ok": 0, "failed": 0,
            })
            return True, dict(_extract)
        _extract.update({
            "status": "running", "total": len(items), "done": 0, "current": "",
            "log": ["Menyiapkan %d produk..." % len(items)],
            "startedAt": int(time.time() * 1000), "finishedAt": None,
            "error": "", "ok": 0, "failed": 0,
        })
    threading.Thread(target=_extract_worker, args=(items,), daemon=True).start()
    return True, dict(_extract)


# ---------------- penyimpanan video ----------------
# Nama folder/file datang dari klien, jadi harus divalidasi: tanpa ini "../.."
# bisa menulis ke luar data/video.
_SAFE_KEY = re.compile(r"[^A-Za-z0-9_.-]+")


def _video_dir(key):
    k = _SAFE_KEY.sub("_", str(key or "").strip())[:80]
    if not k:
        return None
    p = (VIDEO_DIR / k).resolve()
    try:
        p.relative_to(VIDEO_DIR.resolve())
    except ValueError:
        return None
    return p


def _video_file(key, name):
    d = _video_dir(key)
    if not d:
        return None
    n = _SAFE_KEY.sub("_", str(name or "").strip())[:120]
    if not n or not n.lower().endswith(tuple(VIDEO_EXTS)):
        return None
    p = (d / n).resolve()
    try:
        p.relative_to(d)
    except ValueError:
        return None
    return p


def video_list():
    """Daftar file video yang benar-benar ada di disk, dikelompokkan per produk.
    Dipakai UI untuk menandai video yatim (file hilang / dihapus manual)."""
    out = {}
    if not VIDEO_DIR.exists():
        return out
    for d in VIDEO_DIR.iterdir():
        if not d.is_dir():
            continue
        files = []
        for f in sorted(d.iterdir()):
            if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
                files.append({"file": f.name, "size": f.stat().st_size,
                              "at": int(f.stat().st_mtime * 1000)})
        if files:
            out[d.name] = files
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # log ringkas, jangan spam konsol
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("%s %s\n" % (self.command, self.path))
            return
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    # Hanya halaman lokal (127.0.0.1 / localhost, port apa pun) yang boleh
    # memanggil API. Ini untuk preview panel yang jalan di port lain.
    # Origin internet dan file:// (Origin: null) sengaja ditolak.
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    # Semua permintaan berkas statis (GET maupun HEAD) lewat sini. Kalau path-nya
    # tidak lolos daftar putih, jawab 404 — jangan pernah menyentuh disk.
    def send_head(self):
        if not static_ok(urlparse(self.path).path):
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # HTML/JS/CSS tidak boleh di-cache browser. Tanpa ini Chrome memakai
    # heuristic caching (berdasar Last-Modified), jadi app.js lama bisa terus
    # dipakai setelah file di disk diperbarui — UI terlihat "rusak" padahal
    # kodenya sudah benar. Aset gambar/video tetap boleh di-cache.
    #
    # PENTING: "/" juga harus dihitung HTML. SimpleHTTPRequestHandler melayani
    # index.html untuk path "/", tapi path-nya tidak berakhiran ".html", jadi
    # dulu lolos dari aturan ini. Akibatnya index.html ter-cache, dan seluruh
    # referensi app.js?v=... di dalamnya ikut beku — perubahan apa pun tidak
    # pernah sampai ke browser meski file di disk sudah baru.
    def end_headers(self):
        path = urlparse(self.path).path.lower()
        if path in ("", "/") or path.endswith((".html", ".htm", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _path(self):
        u = urlparse(self.path)
        return u.path, parse_qs(u.query)

    def _is_local(self):
        """True kalau permintaan datang dari mesin ini sendiri (bukan lewat Caddy).

        Dipakai untuk memutuskan boleh tidaknya API key ikut terkirim: di laptop
        pemilik aplikasi itu wajar, di alamat publik tidak.
        """
        return self._client_ip() in ("127.0.0.1", "::1", "localhost")

    def _client_ip(self):
        # Di belakang Caddy semua permintaan datang dari 127.0.0.1, jadi alamat
        # asli dibaca dari X-Real-IP yang diisi Caddyfile.
        ip = (self.headers.get("X-Real-IP") or "").strip()
        return ip or self.client_address[0]

    # ---- proksi LLM: /api/llm/<sisanya> diteruskan ke LLM_UPSTREAM/<sisanya>
    def _llm_forward(self, path):
        if not LLM_UPSTREAM:
            return self._json({
                "error": "LLM belum disiapkan di server",
                "detail": "Isi LLM_UPSTREAM (dan LLM_API_KEY) di berkas .env, "
                          "lalu jalankan ulang layanan.",
            }, 503)
        if not llm_allow(self._client_ip()):
            return self._json({
                "error": "Terlalu banyak permintaan LLM dari alamat ini. "
                         "Coba lagi beberapa menit lagi."
            }, 429)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 1024 * 1024:                  # prompt kita jauh di bawah ini
            return self._json({"error": "body terlalu besar"}, 413)
        body = self.rfile.read(length) if length else b""

        if (LLM_REASONING_EFFORT or LLM_MAX_TOKENS) and body:
            try:
                obj = json.loads(body.decode("utf-8"))
            except Exception:
                obj = None
            if isinstance(obj, dict):
                if LLM_REASONING_EFFORT:
                    obj["reasoning_effort"] = LLM_REASONING_EFFORT
                if LLM_MAX_TOKENS:
                    cur = obj.get("max_tokens")
                    if not isinstance(cur, int) or cur < LLM_MAX_TOKENS:
                        obj["max_tokens"] = LLM_MAX_TOKENS
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")

        url = LLM_UPSTREAM + path[len("/api/llm"):]
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        if LLM_API_KEY:
            req.add_header("Authorization", "Bearer " + LLM_API_KEY)

        try:
            with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as r:
                code = r.status
                ctype = r.headers.get("Content-Type") or "application/json"
                data = r.read()
        except urllib.error.HTTPError as e:
            # kesalahan dari penyedia diteruskan apa adanya supaya pesan di UI
            # tetap informatif (401 key salah, 429 kuota, 404 model keliru)
            code = e.code
            ctype = (e.headers.get("Content-Type") if e.headers else None) or "application/json"
            try:
                data = e.read()
            except Exception:
                data = b'{"error":"gagal membaca balasan penyedia"}'
        except Exception as e:
            return self._json({
                "error": "LLM tidak terjangkau: %s" % e,
                "detail": "Periksa LLM_UPSTREAM dan koneksi keluar dari server.",
            }, 502)

        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- video: streaming dengan dukungan Range (supaya scrub di player jalan)
    def _send_video(self, qs):
        key = (qs.get("key", [""])[0] or "").strip()
        name = (qs.get("file", [""])[0] or "").strip()
        p = _video_file(key, name)
        if not p or not p.exists() or not p.is_file():
            return self._json({"error": "video tidak ditemukan"}, 404)
        size = p.stat().st_size
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range") or ""
        m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:                                   # bytes=-N : N byte terakhir
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self._cors()
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        # video boleh di-cache browser: isinya tidak pernah berubah untuk nama
        # file yang sama (nama memakai timestamp).
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        with p.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(256 * 1024, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return                          # user menutup player di tengah jalan
                left -= len(chunk)

    def _video_upload(self, qs):
        key = (qs.get("key", [""])[0] or "").strip()
        d = _video_dir(key)
        if not d:
            return self._json({"error": "key produk tidak valid"}, 400)
        raw_name = self.headers.get("X-Filename") or "video.mp4"
        try:
            raw_name = unquote(raw_name)
        except Exception:
            pass
        ext = Path(raw_name).suffix.lower()
        if ext not in VIDEO_EXTS:
            return self._json({"error": "format harus %s" % ", ".join(sorted(VIDEO_EXTS))}, 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._json({"error": "file kosong"}, 400)
        if length > VIDEO_MAX:
            return self._json({"error": "maksimal %d MB" % (VIDEO_MAX // (1024 * 1024))}, 413)

        d.mkdir(parents=True, exist_ok=True)
        name = "%d%s" % (int(time.time() * 1000), ext)
        dest = d / name
        tmp = d / (name + ".part")
        written = 0
        try:
            with tmp.open("wb") as f:
                while written < length:
                    chunk = self.rfile.read(min(1024 * 1024, length - written))
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
            if written != length:
                tmp.unlink(missing_ok=True)
                return self._json({"error": "upload terputus (%d dari %d byte)" % (written, length)}, 400)
            tmp.replace(dest)
        except Exception as e:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            return self._json({"error": "gagal menyimpan: %s" % e}, 500)
        return self._json({"ok": True, "file": name, "size": written,
                           "dir": d.name, "original": raw_name})

    def _video_delete(self, qs):
        key = (qs.get("key", [""])[0] or "").strip()
        name = (qs.get("file", [""])[0] or "").strip()
        p = _video_file(key, name)
        if not p or not p.exists():
            return self._json({"error": "video tidak ditemukan"}, 404)
        try:
            p.unlink()
        except Exception as e:
            return self._json({"error": "gagal menghapus: %s" % e}, 500)
        d = p.parent
        try:
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        except Exception:
            pass
        return self._json({"ok": True})

    def do_GET(self):
        path, qs = self._path()
        if path == "/api/health":
            # path database tidak perlu keluar ke publik — cukup status.
            return self._json({"ok": True, "store": STORE, "rev": read_state()["rev"]})
        if path == "/api/state":
            rev = qs.get("rev", [None])[0]
            if rev is not None:
                try:
                    got = read_state(int(rev))
                except ValueError:
                    return self._json({"error": "rev harus angka"}, 400)
                if got is None:
                    return self._json({"error": "revisi tidak ditemukan"}, 404)
            else:
                got = read_state()
            # Mesin database ikut disebut supaya sidebar bisa menampilkan
            # "PostgreSQL" atau "SQLite" tanpa permintaan tambahan.
            got["store"] = STORE
            # Kunci LLM tidak pernah keluar dari mesin ini. Dari localhost tetap
            # terkirim (pemilik aplikasi butuh); lewat alamat publik diredaksi.
            if got.get("state") and not self._is_local():
                redact_ai_keys(got["state"])
            return self._json(got)
        if path == "/api/history":
            try:
                limit = int(qs.get("limit", ["20"])[0])
            except ValueError:
                limit = 20
            total, items = history(max(1, min(200, limit)))
            return self._json({"items": items, "total": total})
        if path == "/api/extract":
            pending = pending_from_state()               # di luar lock: ada I/O database
            with _extract_lock:
                job = dict(_extract)
            job["pending"] = len(pending)
            job["pendingDetail"] = sum(1 for p in pending if p["need"] == "detail")
            job["pendingMedia"] = sum(1 for p in pending if p["need"] == "media")
            job["capability"] = extract_capability()
            return self._json(job)
        if path == "/api/assets":
            return self._json(assets_manifest())
        if path == "/api/video":
            return self._send_video(qs)
        if path == "/api/videos":
            return self._json({"dir": str(VIDEO_DIR), "items": video_list()})
        if path == "/api/llm/status":
            # Dipakai UI untuk tahu apakah key LLM diurus server. Kalau ya,
            # browser tidak perlu (dan tidak boleh) menyimpan key sendiri.
            return self._json({
                "configured": bool(LLM_UPSTREAM),
                "model": LLM_MODEL,
                "basePath": "/api/llm",
            })
        if path.startswith("/api/"):
            return self._json({"error": "endpoint tidak dikenal"}, 404)
        return super().do_GET()

    def do_PUT(self):
        path, _ = self._path()
        if path != "/api/state":
            return self._json({"error": "endpoint tidak dikenal"}, 404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 64 * 1024 * 1024:
                return self._json({"error": "ukuran body tidak masuk akal"}, 400)
            raw = self.rfile.read(length)
            obj = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._json({"error": "body bukan JSON: %s" % e}, 400)

        state = obj.get("state") if isinstance(obj, dict) else None
        if not isinstance(state, dict) or not isinstance(state.get("items"), list):
            return self._json({"error": "body harus {\"state\": {\"items\": [...]}}"}, 400)

        # penulisan optimistis: klien menyebutkan revisi yang dia baca. Kalau di
        # antaranya ada tab/proses lain yang menulis, tolak — jangan menimpa diam-diam.
        base = obj.get("baseRev")

        body_text = json.dumps(state, ensure_ascii=False)
        with _lock:
            cur_state = read_state()
            cur = cur_state["rev"]
            if isinstance(base, int) and base != cur:
                return self._json(
                    {"error": "konflik", "rev": cur, "baseRev": base,
                     "message": "data sudah diubah pihak lain sejak terakhir dibaca"},
                    409,
                )
            # Klien jarak jauh tidak pernah menerima kunci, jadi state yang
            # dikirim baliknya berisi key kosong. Tanpa ini, satu klik simpan
            # dari pengunjung akan menghapus kunci milik pemilik aplikasi.
            if not self._is_local():
                restore_ai_keys(state, ai_key_slots(cur_state["state"] or {}))
                body_text = json.dumps(state, ensure_ascii=False)
            rev, size, made = write_state(body_text)
        return self._json({"ok": True, "rev": rev, "bytes": size, "snapshot": made})

    def do_POST(self):
        path, qs = self._path()
        if path.startswith("/api/llm/"):
            return self._llm_forward(path)
        if path == "/api/video":
            return self._video_upload(qs)
        if path == "/api/extract":
            cap = extract_capability()
            if not cap["available"]:
                # 200, bukan 4xx: ini keadaan yang sudah diketahui, bukan
                # permintaan salah. UI memakai ini untuk menampilkan keterangan.
                return self._json({
                    "status": "unavailable",
                    "reason": cap["reason"],
                    "capability": cap,
                    "message": "Detail produk belum bisa diambil dari server ini.",
                })
            started, job = start_extract()
            job["capability"] = cap
            return self._json(job, 200 if started else 409)
        if path == "/api/restore":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                obj = json.loads(self.rfile.read(length).decode("utf-8"))
                rev = int(obj.get("rev"))
            except Exception:
                return self._json({"error": "butuh {\"rev\": N}"}, 400)
            got = read_state(rev)
            if not got:
                return self._json({"error": "revisi tidak ditemukan"}, 404)
            with _lock:
                new_rev, size, _ = write_state(json.dumps(got["state"], ensure_ascii=False))
            return self._json({"ok": True, "rev": new_rev, "bytes": size})
        return self._json({"error": "endpoint tidak dikenal"}, 404)

    def do_DELETE(self):
        path, qs = self._path()
        if path == "/api/video":
            return self._video_delete(qs)
        return self._json({"error": "endpoint tidak dikenal"}, 404)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()


def pg_label():
    """DSN tanpa password, untuk baris log."""
    return re.sub(r"(://[^:/@]+:)[^@]*@", r"\1***@", PG_DSN)


def main():
    if "--help" in sys.argv:
        print(__doc__)
        return

    # Di bawah systemd stdout adalah pipe, jadi print tertahan di buffer sampai
    # proses mati — log startup tidak pernah muncul di journalctl. Baris-baris
    # di bawah ini justru yang paling dibutuhkan saat ada masalah.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    if STORE == "postgres":
        print("Database: PostgreSQL", pg_label())
        try:
            st = read_state()
            n = len((st.get("state") or {}).get("items") or [])
            print("  revisi %d · %d produk · %d byte" % (st["rev"], n, st["bytes"]))
        except Exception as e:
            # Jangan matikan layanan: systemd akan mengulang terus dan gejalanya
            # jadi "502" tanpa penjelasan. Cetak sebabnya, biarkan tetap hidup.
            print("! PostgreSQL tidak terjangkau:", e)
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not DB_PATH.exists():
            print("Database baru dibuat:", DB_PATH)
        else:
            size = DB_PATH.stat().st_size
            print("Database:", DB_PATH, "(%d KB)" % max(1, round(size / 1024)))
            bak = DB_PATH.with_suffix(".db.bak")
            try:
                shutil.copy2(DB_PATH, bak)
                print("Cadangan harian:", bak.name)
            except Exception as e:
                print("! gagal membuat cadangan:", e)

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Affiliate Studio jalan di http://%s:%d/" % (HOST, PORT))
    print("Buka alamat itu di browser apa pun — datanya sama. Ctrl+C untuk berhenti.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nBerhenti.")
        srv.server_close()


if __name__ == "__main__":
    main()
