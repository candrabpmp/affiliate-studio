#!/usr/bin/env python3
"""Pasang LLM server (satu key untuk semua pengunjung) ke VPS.

Membaca _deploy/llm-server.txt, menulis nilai LLM_* ke
/opt/affiliate-studio/.env di VPS tanpa menyentuh variabel lain, menjalankan
ulang layanan, lalu menguji satu permintaan sungguhan lewat URL publik.

    python scripts/set-llm-server.py            # pasang + uji
    python scripts/set-llm-server.py --cek      # hanya uji yang terpasang
    python scripts/set-llm-server.py --hapus    # matikan lagi (kembali ke key pengunjung)

Kunci tidak pernah dicetak. Skrip berhenti sebelum menulis kalau API_KEY kosong.
"""
import base64
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / "_deploy" / "llm-server.txt"
SSH_KEY = Path.home() / ".ssh" / "id_ed25519_deploy"
HOST = "ubuntu@43.128.104.197"
PUBLIC = "https://43-128-104-197.sslip.io"
ENV_PATH = "/opt/affiliate-studio/.env"

SSH = ["ssh", "-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=no", HOST]
SCP = ["scp", "-q", "-i", str(SSH_KEY), "-o", "StrictHostKeyChecking=no"]


def sh(args, **kw):
    r = subprocess.run(args, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "").strip()
        raise SystemExit("perintah gagal: %s\n%s" % (" ".join(args[:3]), msg))
    return r.stdout


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


def baca_env_lama():
    """Isi .env sekarang, tanpa baris LLM_* (yang akan ditimpa)."""
    raw = sh(SSH + ["sudo cat %s | base64 -w0" % ENV_PATH])
    teks = base64.b64decode(raw.strip()).decode("utf-8", "replace")
    simpan = []
    for baris in teks.splitlines():
        if re.match(r"^\s*LLM_[A-Z_]+\s*=", baris):
            continue
        simpan.append(baris)
    return "\n".join(simpan).strip()


def tulis_env(lama, nilai):
    baru = {
        "LLM_UPSTREAM": nilai.get("BASE_URL", "").rstrip("/"),
        "LLM_API_KEY": nilai.get("API_KEY", ""),
        "LLM_MODEL": nilai.get("MODEL", ""),
        "LLM_RATE_PER_10MIN": nilai.get("RATE_PER_10MIN", "200") or "200",
    }
    isi = lama + "\n\n# --- LLM server (dipasang oleh scripts/set-llm-server.py) ---\n"
    isi += "\n".join("%s=%s" % (k, v) for k, v in baru.items()) + "\n"

    tmp = ROOT / "_deploy" / ".env.baru"
    tmp.write_text(isi, encoding="utf-8", newline="\n")
    sh(SCP + [str(tmp), HOST + ":/tmp/affiliate.env"])
    tmp.unlink(missing_ok=True)
    sh(SSH + [
        "sudo install -m 600 -o root -g root /tmp/affiliate.env %s && rm -f /tmp/affiliate.env" % ENV_PATH
    ])
    return baru


def hapus_env():
    lama = baca_env_lama()
    isi = lama + "\n"
    tmp = ROOT / "_deploy" / ".env.baru"
    tmp.write_text(isi, encoding="utf-8", newline="\n")
    sh(SCP + [str(tmp), HOST + ":/tmp/affiliate.env"])
    tmp.unlink(missing_ok=True)
    sh(SSH + [
        "sudo install -m 600 -o root -g root /tmp/affiliate.env %s && rm -f /tmp/affiliate.env" % ENV_PATH
    ])


def restart():
    sh(SSH + ["sudo systemctl restart affiliate-studio"])
    status = sh(SSH + ["systemctl is-active affiliate-studio"]).strip()
    print("layanan:", status)
    if status != "active":
        raise SystemExit("layanan tidak aktif — periksa: journalctl -u affiliate-studio -n 30")


def status():
    with urllib.request.urlopen(PUBLIC + "/api/llm/status", timeout=20) as r:
        return json.load(r)


def uji(model):
    """Satu permintaan kecil lewat proksi publik: membuktikan key, upstream,
    dan model benar-benar bekerja dari server — bukan cuma .env terbaca."""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Balas satu kata: siap"}],
        "max_tokens": 16,
    }).encode("utf-8")
    req = urllib.request.Request(
        PUBLIC + "/api/llm/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.load(r)
            teks = (d.get("choices") or [{}])[0].get("message", {}).get("content")
            return True, "HTTP %d · model %s · balasan %r" % (
                r.status, d.get("model") or model, (teks or "").strip()[:60])
    except urllib.error.HTTPError as e:
        isi = e.read().decode("utf-8", "replace")[:400]
        return False, "HTTP %d · %s" % (e.code, isi)
    except Exception as e:
        return False, "tidak terjangkau: %s" % e


def main():
    arg = (sys.argv[1] if len(sys.argv) > 1 else "").strip()

    if arg == "--hapus":
        hapus_env()
        restart()
        print("LLM server dimatikan. Pengunjung kembali memakai setelan browser.")
        print("status:", status())
        return

    if arg == "--cek":
        st = status()
        print("status:", json.dumps(st, ensure_ascii=False))
        if not st.get("configured"):
            raise SystemExit("LLM server belum terpasang.")
        ok, pesan = uji(st.get("model") or "")
        print(("OK   " if ok else "GAGAL ") + pesan)
        return

    nilai = baca_txt()
    base = (nilai.get("BASE_URL") or "").strip()
    key = (nilai.get("API_KEY") or "").strip()
    model = (nilai.get("MODEL") or "").strip()

    if not base.startswith("http"):
        raise SystemExit("BASE_URL belum diisi (contoh: https://ai.sumopod.com/v1)")
    if len(key) < 8:
        raise SystemExit("API_KEY belum diisi di _deploy/llm-server.txt")
    if not model:
        raise SystemExit("MODEL belum diisi")

    print("BASE_URL :", base)
    print("API_KEY  : %d karakter (tidak dicetak)" % len(key))
    print("MODEL    :", model)

    baru = tulis_env(baca_env_lama(), nilai)
    print(".env VPS diperbarui:", ", ".join(sorted(baru)))
    restart()

    st = status()
    print("status  :", json.dumps(st, ensure_ascii=False))
    if not st.get("configured"):
        raise SystemExit("server melaporkan belum terkonfigurasi — periksa .env")

    ok, pesan = uji(st.get("model") or model)
    print(("OK      " if ok else "GAGAL   ") + pesan)
    if not ok:
        raise SystemExit("key/upstream/model ditolak. Perbaiki llm-server.txt lalu ulangi.")

    print("\nSelesai. Semua pengunjung memakai LLM ini; tidak ada popup key di browser.")


if __name__ == "__main__":
    main()
