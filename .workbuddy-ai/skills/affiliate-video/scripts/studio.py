#!/usr/bin/env python3
"""Toolkit Affiliate Studio untuk dipakai dari luar aplikasi (skill / CLI).

Kenapa ada
----------
Aplikasi ini punya logika yang sudah matang: cara menyusun prompt video,
cara menamai folder video, cara memvalidasi key produk. Semua itu hidup di
app.js dan server.py. Kalau skill WorkBuddy menulis ulang logikanya sendiri,
dua versi akan melenceng dan prompt yang dihasilkan skill tidak lagi sama
dengan yang dilihat user di aplikasi.

Jadi file ini adalah SATU pintu: membaca database yang sama, memakai aturan
penamaan yang sama dengan server.py, dan menyusun prompt dengan struktur yang
sama dengan videoPrompt() di app.js.

Perintah
--------
    list                      daftar produk + status draf/video
    item KEY                  satu produk (JSON)
    prompt KEY                teks prompt video siap tempel ke generator
    asset KEY                 foto produk terbaik untuk frame pertama
    place KEY FILE            salin file video ke data/video/<key>/
    verify                    bandingkan isi disk dengan catatan di database

Semua perintah menerima --root untuk menunjuk folder studio lain.
"""
import argparse
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------- lokasi

def find_root(explicit=None):
    """Folder studio: yang berisi data/affiliate.db dan app.js."""
    cands = []
    if explicit:
        cands.append(Path(explicit))
    if os.environ.get("AFFILIATE_ROOT"):
        cands.append(Path(os.environ["AFFILIATE_ROOT"]))
    # skill ini tinggal di <root>/.workbuddy-ai/skills/affiliate-video/scripts
    here = Path(__file__).resolve()
    if len(here.parents) > 4:
        cands.append(here.parents[4])
    cands.append(Path.cwd())
    for c in cands:
        c = c.expanduser().resolve()
        if (c / "app.js").exists() and (c / "data").is_dir():
            return c
    raise SystemExit(
        "Folder studio tidak ditemukan. Jalankan dengan --root <folder afiliasi>."
    )


ROOT = find_root()
DB_PATH = Path(os.environ.get("AFFILIATE_DB") or (ROOT / "data" / "affiliate.db"))
VIDEO_DIR = Path(os.environ.get("AFFILIATE_VIDEO_DIR") or (ROOT / "data" / "video"))
ASSET_DIR = ROOT / "assets"
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
VIDEO_MAX = 200 * 1024 * 1024
_SAFE_KEY = re.compile(r"[^A-Za-z0-9_.-]+")

try:                                    # konsol Windows sering bukan UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", newline="\n")
except Exception:
    pass


def safe_key(key):
    """Aturan yang sama dengan server.py — folder video harus cocok."""
    k = _SAFE_KEY.sub("_", str(key or "").strip())[:80]
    return k or None


# ---------------------------------------------------------------- database

def read_state():
    if not DB_PATH.exists():
        raise SystemExit("Database belum ada: %s" % DB_PATH)
    con = sqlite3.connect("file:%s?mode=ro" % DB_PATH.as_posix(), uri=True)
    try:
        row = con.execute("select rev, body from state order by rev desc limit 1").fetchone()
    finally:
        con.close()
    if not row:
        raise SystemExit("Tabel state kosong.")
    return row[0], json.loads(row[1])


def tiktok_of(item):
    return ((item.get("platforms") or {}).get("tiktok") or {})


def media_of(item):
    return tiktok_of(item).get("media") or {}


def videos_of(item):
    return [v for v in (media_of(item).get("videos") or []) if v.get("file")]


def picked_video(item):
    m = media_of(item)
    vs = videos_of(item)
    for v in vs:
        if v.get("file") == m.get("pick"):
            return v
    return vs[-1] if vs else None


def find_item(state, key):
    for it in state.get("items") or []:
        if str(it.get("key")) == str(key):
            return it
    # terima juga productId / potongan nama, supaya user tidak wajib hafal key
    for it in state.get("items") or []:
        if str(it.get("productId")) == str(key):
            return it
    q = str(key).lower()
    hits = [it for it in (state.get("items") or []) if q in str(it.get("name", "")).lower()]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        names = "\n".join("  %s  %s" % (h.get("key"), str(h.get("name"))[:60]) for h in hits[:8])
        raise SystemExit("Nama '%s' cocok dengan %d produk. Pakai key:\n%s" % (key, len(hits), names))
    raise SystemExit("Produk '%s' tidak ada. Lihat: studio.py list" % key)


# ---------------------------------------------------------------- prompt
# Port dari app.js: sceneRows / vpMergeScenes / vpSceneCount / vpSpan /
# vpOrient / vpFitNote / vpFrameNote / vpUiNote / videoPrompt.
# Kalau app.js diubah, ubah di sini juga — lalu jalankan `prompt` dan bandingkan
# dengan yang tampil di modal aplikasi.

SEC_PER_SCENE = 2.4
UI_RX = re.compile(
    "|".join([
        "keranjang", "bakul", "link", r"\bbio\b", "checkout", "swipe", "klik",
        "tombol", "ikon", "aplikasi", r"\bapp\b", "shopee", "tokopedia", "lazada",
        "tiktok shop", "online shop", "toko online", "browsing", "marketplace",
        r"e-?commerce", "screenshot", "tangkapan layar", "scroll", r"\bfeed\b",
        "google", "ponsel", "smartphone", "layar hp", r"di hp\b", "notifikasi",
    ]),
    re.I,
)


def scene_rows(scenes):
    out = []
    for i, s in enumerate(scenes or []):
        n = "%02d" % (i + 1)
        if isinstance(s, dict):
            visual = str(s.get("visual") or s.get("text") or s.get("scene") or "").strip()
            overlay = str(s.get("overlay") or "").strip()
            vo = str(s.get("vo") or "").strip()
        else:
            visual, overlay, vo = str("" if s is None else s).strip(), "", ""
        if visual or overlay or vo:
            out.append({"n": n, "visual": visual, "overlay": overlay, "vo": vo})
    return out


def lower_first(s):
    t = str(s or "").strip()
    if not t:
        return ""
    if re.match(r"^[A-Z]{2}", t):        # akronim: HP, TV, RCA
        return t
    return t[0].lower() + t[1:]


def merge_scenes(rows, want):
    n = len(rows)
    if not n or want >= n:
        return [dict(r) for r in rows]
    join = ["lalu", "kemudian", "setelah itu"]
    out = []
    for i in range(want):
        start = math.floor((i * n) / want)
        end = max(math.floor(((i + 1) * n) / want), start + 1)
        group = rows[start:end]
        acc = group[0]["visual"]
        for g in group[1:]:
            acc = re.sub(r"[.;,:]+$", "", acc)
            conn = next((c for c in join if not re.search(r"\b" + c + r"\b", acc, re.I)), join[0])
            acc += " " + conn + " " + lower_first(g["visual"])
        out.append({
            "n": "%02d" % (i + 1),
            "visual": acc,
            "overlay": next((g["overlay"] for g in group if g["overlay"]), ""),
            "vo": " ".join(g["vo"] for g in group if g["vo"]),
        })
    return out


def scene_count(rows, dur, scenes):
    n = len(rows)
    if not n:
        return 0
    if scenes and str(scenes) != "auto":
        return max(2, min(int(scenes), n))
    if not dur:                                   # durasi panjang: semua adegan
        return n
    return max(2, min(n, int(math.floor(dur / SEC_PER_SCENE + 0.5))))   # = Math.round


def span(dur):
    if str(dur) == "long":
        return {"id": "20–30 detik", "sec": 0}
    return {"id": "%s detik" % dur, "sec": int(dur)}


def orient(ratio):
    if ratio == "16:9":
        return "horizontal 16:9 (1920x1080)"
    return "vertikal 9:16 (1080x1920)"


def fit_note(sec, n):
    if not sec or not n:
        return ""
    # JS memakai toFixed(1): kalau hasilnya pas di tengah (2,25), JS membulatkan
    # KE ATAS; Python membulatkan ke angka genap (2,2). Selisih sekecil ini tetap
    # membuat prompt skill beda dengan yang dilihat user di modal, jadi disamakan.
    per = ("%.1f" % (math.floor((sec / n) * 10 + 0.5) / 10)).replace(".", ",")
    return (
        "CATATAN DURASI: hanya %d detik untuk %d adegan, jadi tiap adegan sekitar %s detik "
        "dan dipotong cepat. Jangan memperpanjang adegan dan jangan menambah adegan baru. "
        "Produk harus sudah terlihat sebelum detik ke-2 — jangan menghabiskan waktu di adegan "
        "pembuka. Kalau harus memangkas, gabungkan adegan yang mirip — jangan buang adegan 01 "
        "dan adegan terakhir." % (sec, n, per)
    )


def frame_note(ratio):
    if ratio == "16:9":
        return ("Komposisi: subjek utama di tengah, sisakan ruang di kiri dan kanan supaya "
                "tetap aman kalau nanti di-crop ke 9:16.")
    return ("Komposisi: vertikal, subjek utama di tengah, sisakan ruang kosong sekitar 15% "
            "di bagian atas dan bawah.")


def ui_note(rows):
    """Kalimat POSITIF saja. Menyebut benda terlarang justru memancing model
    menggambar benda itu — negasi tidak dipatuhi generator video."""
    if not any(UI_RX.search(r["visual"]) or UI_RX.search(r["overlay"]) for r in rows):
        return ""
    return ("Gambar harus bersih: hanya orang, produk, dan ruangan di belakangnya. Tidak ada "
            "apa pun yang digambar menimpa rekaman. Kalau sebuah adegan butuh layar ponsel atau "
            "halaman toko, rekam dari sudut miring, tidak fokus, dan tidak terbaca — cukup "
            "gestur tangan sebagai gantinya.")


def video_prompt(item, dur="9", ratio="9:16", scenes="auto", max_chars=0):
    """Susun prompt. Kalau max_chars diisi, blok dipangkas berurutan sampai
    muat — generator berbeda punya batas berbeda (kling-video-v3: 2500).

    Urutan pangkas sengaja dari yang paling tidak merusak:
    NARASI -> MUSIK -> butir ATURAN VISUAL dari bawah -> CATATAN ELEMEN LAYAR.
    Yang tidak pernah dibuang: HOOK, STORYBOARD, TEKS DI LAYAR, CATATAN DURASI,
    komposisi, dan gambar bersih. Kalau masih tidak muat, berhenti dengan error
    yang jelas — memotong kalimat di tengah lebih buruk daripada gagal.
    """
    t = tiktok_of(item)
    raw = scene_rows(t.get("scenes"))
    sp = span(dur)
    rows = merge_scenes(raw, scene_count(raw, sp["sec"], scenes))
    ori = orient(ratio)

    A = ["Video %s, SATU klip %s, gaya handheld natural seperti rekaman sendiri, bukan "
         "iklan. Satu orang, satu produk, tanpa aktor tambahan." % (ori, sp["id"])]
    B = ["", "PRODUK: " + str(item.get("name") or "") +
         ((" — " + str(item["priceText"])) if item.get("priceText") else "")]
    C = ["", "HOOK (detik pertama, harus langsung kena):", str(t["hook"])] if t.get("hook") else []
    D = []
    if rows:
        D = ["", "STORYBOARD:"]
        for r in rows:
            line = "%s. %s" % (r["n"], r["visual"])
            if r["overlay"]:
                line += " (teks di layar: %s)" % r["overlay"]
            if r["vo"]:
                line += " (VO: %s)" % r["vo"]
            D.append(line)
    E = [""]
    F = ["TEKS DI LAYAR UTAMA (tulis persis dalam Bahasa Indonesia, jangan diganti): "
         + str(t["coverText"])] if t.get("coverText") else []
    G = ["MUSIK: " + str(t["music"])] if t.get("music") else []
    H = ["", "NARASI (boleh jadi VO, jangan ditulis penuh di layar):", str(t["caption"])] \
        if t.get("caption") else []
    fit = fit_note(sp["sec"], len(rows))
    I = ["", fit] if fit else []
    ui = ui_note(raw)
    J = ["", "CATATAN ELEMEN LAYAR: " + ui] if ui else []
    bullets = [
        "- " + frame_note(ratio),
        "- Gambar bersih: hanya orang, produk, dan ruangan di belakangnya. Tidak ada apa pun "
        "yang digambar menimpa rekaman, termasuk di tepi frame.",
        "- Produk yang sama, bentuk dan warna identik di setiap adegan.",
        "- Cahaya indoor natural, bukan gaya studio iklan.",
        "- Tanpa pose jualan: tidak ada jempol ke kamera, tidak ada menatap kamera sambil "
        "tersenyum di akhir, tidak ada gerakan tangan ala iklan.",
        "- Tangan dan wajah manusia normal, tidak cacat, jari tidak berlebih.",
        "- Tanpa teks tambahan di luar yang disebutkan, tanpa watermark, tanpa logo.",
        "- Jangan menampilkan harga atau angka yang tidak ada di data produk.",
    ]
    K = ["", "ATURAN VISUAL:"] + bullets
    L = ["", "OUTPUT: 1 klip video %s, %s, gambar bersih tanpa lapisan tambahan di atasnya."
         % (sp["id"], ori)]

    def build():
        return "\n".join(A + B + C + D + E + F + G + H + I + J + K + L)

    if not max_chars:
        return build()

    for drop in ("H", "G", "J"):
        if len(build()) <= max_chars:
            return build()
        if drop == "H":
            H = []
        elif drop == "G":
            G = []
        else:
            J = []
    # butir aturan visual, dari bawah, sisakan minimal empat yang paling penting
    while len(build()) > max_chars and len(bullets) > 4:
        bullets.pop()
        K = ["", "ATURAN VISUAL:"] + bullets
    out = build()
    if len(out) > max_chars:
        raise SystemExit(
            "Prompt masih %d karakter setelah dipangkas (batas %d). Perpendek draf TikTok-nya "
            "atau pakai --dur long supaya jumlah adegan bertambah." % (len(out), max_chars))
    return out


# ---------------------------------------------------------------- aset

def asset_candidates(item):
    """Semua foto produk, urut nama. img-01 sering banner promo (latar blok +
    tulisan besar), jadi yang pertama belum tentu yang terbaik."""
    pid = str(item.get("productId") or "")
    d = ASSET_DIR / pid
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir()
                  if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
                  and not p.stem.lower().endswith("-thumb"))


def first_frame(item):
    """Foto produk pertama dari assets/<productId>/. Dipakai sebagai frame
    pertama image-to-video supaya bentuk produk TIDAK dikarang model."""
    c = asset_candidates(item)
    return c[0] if c else None


# ---------------------------------------------------------------- perintah

def cmd_list(args):
    rev, state = read_state()
    rows = []
    for it in state.get("items") or []:
        if it.get("archived") and not args.all:
            continue
        t = tiktok_of(it)
        v = picked_video(it)
        rows.append((
            str(it.get("key")),
            str(it.get("name") or "")[:46],
            str(t.get("status") or "-"),
            "video siap" if v else "tanpa video",
            str((v or {}).get("file") or "-"),
            "%d scene" % len(scene_rows(t.get("scenes"))),
        ))
    if not rows:
        print("Tidak ada produk.")
        return 0
    print("rev %s · %s" % (rev, DB_PATH))
    w = [max(len(r[i]) for r in rows) for i in range(6)]
    print("%-*s  %-*s  %-*s  %-*s  %-*s  %s" % (
        w[0], "KEY", w[1], "NAMA", w[2], "STATUS", w[3], "VIDEO", w[4], "FILE", "DRAF"))
    for r in rows:
        print("%-*s  %-*s  %-*s  %-*s  %-*s  %s" % (
            w[0], r[0], w[1], r[1], w[2], r[2], w[3], r[3], w[4], r[4], r[5]))
    return 0


def cmd_item(args):
    _, state = read_state()
    it = find_item(state, args.key)
    t = tiktok_of(it)
    out = {
        "key": it.get("key"), "name": it.get("name"), "price": it.get("priceText"),
        "productId": it.get("productId"), "affiliateUrl": it.get("affiliateUrl"),
        "status": t.get("status"), "hook": t.get("hook"), "caption": t.get("caption"),
        "coverText": t.get("coverText"), "music": t.get("music"),
        "duration": t.get("duration"),
        "scenes": scene_rows(t.get("scenes")),
        "videos": videos_of(it), "pick": media_of(it).get("pick") or "",
        "firstFrame": str(first_frame(it)) if first_frame(it) else None,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_prompt(args):
    _, state = read_state()
    it = find_item(state, args.key)
    if not tiktok_of(it).get("scenes") and not tiktok_of(it).get("hook"):
        raise SystemExit("Draf TikTok untuk %s masih kosong — generate dulu di aplikasi." % args.key)
    text = video_prompt(it, args.dur, args.ratio, args.scenes, args.max)
    print(text)
    if args.max:
        sys.stderr.write("panjang: %d dari %d karakter\n" % (len(text), args.max))
    return 0


def cmd_asset(args):
    _, state = read_state()
    it = find_item(state, args.key)
    cands = asset_candidates(it)
    if not cands:
        print("Tidak ada foto di assets/%s/" % (it.get("productId") or "?"))
        return 1
    print(cands[0])                       # baris pertama tetap bisa dipakai $(...)
    if len(cands) > 1:
        # jangan sembunyikan pilihan lain: img-01 sering banner promo bertulisan
        # besar, dan memakainya sebagai frame pertama menghasilkan slide berjalan.
        sys.stderr.write("kandidat lain (%d):\n" % (len(cands) - 1))
        for c in cands[1:]:
            sys.stderr.write("  %s\n" % c)
        sys.stderr.write("Periksa dulu: banner promo (latar blok + tulisan besar) jangan "
                         "dipakai sebagai frame pertama.\n")
    return 0


def cmd_place(args):
    _, state = read_state()
    it = find_item(state, args.key)
    src = Path(args.file).expanduser()
    if not src.exists():
        raise SystemExit("File tidak ada: %s" % src)
    ext = src.suffix.lower()
    if ext not in VIDEO_EXTS:
        raise SystemExit("Format harus salah satu dari: %s" % ", ".join(sorted(VIDEO_EXTS)))
    size = src.stat().st_size
    if size > VIDEO_MAX:
        raise SystemExit("File %d MB, maksimal %d MB." % (size // 1048576, VIDEO_MAX // 1048576))
    k = safe_key(it.get("key"))
    d = VIDEO_DIR / k
    d.mkdir(parents=True, exist_ok=True)
    name = "%d%s" % (int(time.time() * 1000), ext)
    dest = d / name
    shutil.copy2(src, dest)
    print(json.dumps({
        "ok": True, "key": it.get("key"), "file": name,
        "path": str(dest), "size": dest.stat().st_size,
        "note": "Aplikasi mengadopsi file ini otomatis saat halaman dimuat "
                "(reconcileVideos). Muat ulang halaman, badge 'video siap' akan muncul.",
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_verify(args):
    _, state = read_state()
    problems = 0
    print("rev %s · %s" % (read_state()[0], VIDEO_DIR))
    for it in state.get("items") or []:
        if it.get("archived"):
            continue
        k = safe_key(it.get("key"))
        d = VIDEO_DIR / k
        on_disk = {p.name for p in d.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTS} if d.is_dir() else set()
        in_state = {v.get("file") for v in videos_of(it)}
        orphan = on_disk - in_state
        ghost = in_state - on_disk
        if not on_disk and not in_state:
            continue
        flags = []
        if orphan:
            flags.append("yatim: %s" % ", ".join(sorted(orphan)))
        if ghost:
            flags.append("hilang: %s" % ", ".join(sorted(ghost)))
        mark = "OK " if not flags else "!! "
        if flags:
            problems += 1
        print("%s%-14s %-40s %s" % (mark, it.get("key"), str(it.get("name"))[:40],
                                    " · ".join(flags) if flags else
                                    "%d file, dipakai %s" % (len(on_disk), media_of(it).get("pick") or "-")))
    if problems:
        print("\n%d produk tidak sinkron. Buka aplikasi lalu muat ulang halaman — "
              "reconcileVideos() akan merapikannya." % problems)
        return 1
    print("\nSemua sinkron.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Toolkit Affiliate Studio")
    ap.add_argument("--root", help="folder studio (default: dideteksi otomatis)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="daftar produk + status video")
    p.add_argument("--all", action="store_true", help="ikutkan yang diarsipkan")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("item", help="satu produk (JSON)")
    p.add_argument("key")
    p.set_defaults(fn=cmd_item)

    p = sub.add_parser("prompt", help="teks prompt video")
    p.add_argument("key")
    p.add_argument("--dur", default="9", choices=["8", "9", "10", "long"])
    p.add_argument("--ratio", default="9:16", choices=["9:16", "16:9"])
    p.add_argument("--scenes", default="auto", help="auto | 3 | 4 | 5")
    p.add_argument("--max", type=int, default=0,
                   help="batas karakter (mis. 2500 untuk kling-video-v3); "
                        "0 = tanpa batas, sama persis dengan modal aplikasi")
    p.set_defaults(fn=cmd_prompt)

    p = sub.add_parser("asset", help="foto produk untuk frame pertama")
    p.add_argument("key")
    p.set_defaults(fn=cmd_asset)

    p = sub.add_parser("place", help="salin video ke folder produk")
    p.add_argument("key")
    p.add_argument("file")
    p.set_defaults(fn=cmd_place)

    p = sub.add_parser("verify", help="cek disk vs database")
    p.set_defaults(fn=cmd_verify)

    args = ap.parse_args()
    global ROOT, DB_PATH, VIDEO_DIR, ASSET_DIR
    if args.root:
        ROOT = find_root(args.root)
        DB_PATH = Path(os.environ.get("AFFILIATE_DB") or (ROOT / "data" / "affiliate.db"))
        VIDEO_DIR = Path(os.environ.get("AFFILIATE_VIDEO_DIR") or (ROOT / "data" / "video"))
        ASSET_DIR = ROOT / "assets"
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
