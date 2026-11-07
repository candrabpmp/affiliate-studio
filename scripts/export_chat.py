#!/usr/bin/env python3
"""Ekspor riwayat percakapan WorkBuddy menjadi Markdown + HTML yang bisa dibaca.

Kenapa tidak menyerahkan file .jsonl mentah
-------------------------------------------
Transcript aslinya 30 MB dan berisi 2.902 pemanggilan alat, 1.736 blok
reasoning, system-reminder tiap giliran, dan notifikasi task. Yang ingin
dibaca orang hanya dua hal: pertanyaan manusia dan jawaban asisten. Skrip ini
mengambil itu saja, berurutan, dengan cap waktu.

Yang sengaja TIDAK diambil
--------------------------
- reasoning (proses berpikir internal)
- function_call / function_call_result (isi alat)
- system-reminder, task-notification, user_info, identity_context
- ringkasan otomatis antar-sesi (conversation_history_summary)

Yang dibersihkan
----------------
API key berpola sk-... diganti [DISUNTING] — transcript ini memuat satu key
sungguhan pada pemeriksaan pengaturan.js, dan file ini akan dikirim ke orang
lain.

Cara pakai
----------
    python scripts/export_chat.py
    python scripts/export_chat.py --out hackathon/RIWAYAT-CHAT
"""
import argparse
import html
import io
import json
import os
import re
import sys
from datetime import datetime

PROJECT_DIR = os.path.join(
    os.path.expanduser("~"), ".workbuddy-ai", "projects",
    "c-workspace_workbuddy-afiliasi",
)

# Pola yang harus hilang sebelum keluar dari mesin ini.
# Ambang 3 karakter, bukan 10: key di transcript juga muncul dalam bentuk
# terpotong ("sk-2ca...5c48") yang tetap membocorkan awalan dan akhiran.
SECRET_PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9_-]{3,}"), "[DISUNTING]"),
]

# Blok pembungkus yang bukan isi percakapan.
NOISE_TAGS = [
    "system-reminder", "task-notification", "user_info", "identity_context",
    "conversation_history_summary", "craft_mode", "additional-data",
]


def redact(text):
    for pat, rep in SECRET_PATTERNS:
        text = pat.sub(rep, text)
    return text


def text_of(content):
    """Ambil teks dari content yang bisa berupa str atau list of blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for block in content:
        if isinstance(block, dict):
            t = block.get("text")
            if isinstance(t, str):
                out.append(t)
    return "\n".join(out)


def strip_tags(text, tag):
    return re.sub(r"<%s\b[^>]*>.*?</%s>" % (tag, tag), "", text, flags=re.S)


def user_query_of(text):
    """Isi <user_query> kalau ada; kalau tidak, teks setelah noise dibuang."""
    m = re.search(r"<user_query>(.*?)</user_query>", text, flags=re.S)
    if m:
        return m.group(1).strip()
    cleaned = text
    for tag in NOISE_TAGS:
        cleaned = strip_tags(cleaned, tag)
    return cleaned.strip()


def looks_like_noise(text):
    """Pesan tanpa <user_query> yang isinya cuma pembungkus sistem."""
    if not text.strip():
        return True
    markers = [
        "<system-reminder", "<task-notification", "<conversation_history_summary",
        "This session is being continued from a previous conversation",
    ]
    stripped = text
    for tag in NOISE_TAGS:
        stripped = strip_tags(stripped, tag)
    if not stripped.strip():
        return True
    return any(m in text for m in markers) and len(stripped.strip()) < 40


# Kalimat pembuka yang dikirim harness, bukan oleh manusia. Kalau ikut
# terekspor, riwayatnya terbaca seperti percakapan dengan mesin, bukan dengan
# orang — dan pembaca akan bingung siapa yang sedang bicara.
NOISE_PREFIXES = [
    "Use the TaskOutput tool with task_id=",
    "Please continue with the conversation based on the summarized context",
    "This session is being continued from a previous conversation",
]


def is_harness_prompt(text):
    head = text.strip()[:120]
    return any(head.startswith(p) for p in NOISE_PREFIXES)


def load_events(path):
    events = []
    with io.open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") != "message":
                continue
            role = rec.get("role")
            if role not in ("user", "assistant"):
                continue
            ts = rec.get("timestamp") or ""
            raw = text_of(rec.get("content"))
            if not raw.strip():
                continue
            if role == "user":
                if looks_like_noise(raw):
                    continue
                msg = user_query_of(raw)
                if not msg or len(msg) < 1:
                    continue
                if is_harness_prompt(msg):
                    continue
            else:
                msg = raw.strip()
            events.append({"role": role, "at": ts, "text": redact(msg)})
    return events


def merge_turns(events):
    """Gabungkan potongan balasan asisten yang berurutan dalam satu giliran."""
    turns = []
    for ev in events:
        if turns and turns[-1]["role"] == ev["role"] == "assistant":
            if ev["text"] not in turns[-1]["text"]:
                turns[-1]["text"] += "\n\n" + ev["text"]
            turns[-1]["at"] = ev["at"] or turns[-1]["at"]
        else:
            turns.append(dict(ev))
    return turns


def fmt_time(ts):
    if ts in (None, ""):
        return ""
    if isinstance(ts, (int, float)):
        # Transcript menyimpan cap waktu sebagai epoch milidetik.
        return datetime.fromtimestamp(ts / 1000).strftime("%d %b %Y, %H:%M")
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.strftime("%d %b %Y, %H:%M")
    except ValueError:
        return str(ts)[:19]


def to_markdown(turns, source, counts):
    out = []
    out.append("# Riwayat percakapan — Affiliate Studio\n")
    out.append("Sesi `%s`  " % os.path.basename(source))
    out.append("Diekspor %s  " % datetime.now().strftime("%d %B %Y, %H:%M"))
    out.append("**%d pertanyaan, %d balasan.**\n" % (counts[0], counts[1]))
    out.append(
        "Isi: hanya pertanyaan manusia dan jawaban asisten. Proses berpikir "
        "internal, pemanggilan alat, dan pengingat sistem tidak disertakan. "
        "API key sudah disunting.\n"
    )
    out.append("---\n")
    for i, t in enumerate(turns, 1):
        who = "Bos" if t["role"] == "user" else "Orchid"
        out.append("## %d · %s — %s\n" % (i, who, fmt_time(t["at"])))
        out.append(t["text"].strip() + "\n")
    return "\n".join(out)


def to_html(turns, source, counts, title):
    def blocks(text):
        parts = [p.strip() for p in text.split("\n\n") if p.strip()]
        return "\n".join(
            "<p>%s</p>" % html.escape(p).replace("\n", "<br>") for p in parts
        )

    rows = []
    for t in turns:
        cls = "u" if t["role"] == "user" else "a"
        who = "Bos" if t["role"] == "user" else "Orchid"
        rows.append(
            '<div class="msg %s"><div class="h"><b>%s</b><span>%s</span></div>'
            "<div class=\"b\">%s</div></div>"
            % (cls, who, html.escape(fmt_time(t["at"])), blocks(t["text"]))
        )

    return """<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<title>%s</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--ink:#14171f;--mute:#6b7382;
 --line:#e3e6ec;--blue:#2563eb;--coral:#ee4d2d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:16px/1.65 -apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:30px;letter-spacing:-.6px;margin:0 0 8px}
.meta{color:var(--mute);font-size:14px;margin-bottom:28px}
.meta code{background:#eceef3;padding:1px 6px;border-radius:4px;font-size:12px}
.msg{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:16px 20px;margin:14px 0;overflow:hidden}
.msg.u{border-left:4px solid var(--blue)}
.msg.a{border-left:4px solid var(--coral)}
.h{display:flex;justify-content:space-between;align-items:baseline;
 gap:12px;margin-bottom:8px;font-size:13px;color:var(--mute)}
.h b{color:var(--ink);font-size:14px}
/* Tautan Shopee dan tabel CSV tidak punya spasi, jadi tanpa ini teksnya
   menembus tepi kartu dan halaman jadi bisa digeser ke samping. */
.b{overflow-wrap:anywhere;word-break:break-word}
.b p{margin:0 0 10px}
.b p:last-child{margin-bottom:0}
.b code{background:#eceef3;padding:1px 5px;border-radius:4px;font-size:13px}
.note{background:#fff8e6;border:1px solid #f0dca8;border-radius:10px;
 padding:12px 16px;font-size:14px;color:#5a4a1a;margin-bottom:24px}
</style></head><body><div class="wrap">
<h1>%s</h1>
<div class="meta">Sesi <code>%s</code> · diekspor %s · %d pertanyaan, %d balasan</div>
<div class="note">Hanya pertanyaan manusia dan jawaban asisten. Proses berpikir
internal, pemanggilan alat, dan pengingat sistem tidak disertakan. API key sudah
disunting.</div>
%s
</div></body></html>""" % (
        html.escape(title), html.escape(title), html.escape(os.path.basename(source)),
        datetime.now().strftime("%d %B %Y, %H:%M"), counts[0], counts[1],
        "\n".join(rows),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=None, help="path .jsonl (default: terbaru)")
    ap.add_argument("--out", default="hackathon/RIWAYAT-CHAT", help="awalan berkas keluaran")
    args = ap.parse_args()

    source = args.source
    if not source:
        cands = [
            os.path.join(PROJECT_DIR, f)
            for f in os.listdir(PROJECT_DIR) if f.endswith(".jsonl")
        ]
        if not cands:
            sys.exit("Tidak ada .jsonl di %s" % PROJECT_DIR)
        source = max(cands, key=os.path.getmtime)

    events = load_events(source)
    turns = merge_turns(events)
    counts = (
        sum(1 for t in turns if t["role"] == "user"),
        sum(1 for t in turns if t["role"] == "assistant"),
    )

    md = to_markdown(turns, source, counts)
    html_doc = to_html(turns, source, counts, "Riwayat percakapan — Affiliate Studio")

    out_dir = os.path.dirname(args.out) or "."
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    md_path = args.out + ".md"
    html_path = args.out + ".html"
    with io.open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    with io.open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html_doc)

    print("sumber : %s" % source)
    print("giliran: %d pertanyaan, %d balasan" % counts)
    print("markdown: %s (%.1f KB)" % (md_path, os.path.getsize(md_path) / 1024))
    print("html    : %s (%.1f KB)" % (html_path, os.path.getsize(html_path) / 1024))


if __name__ == "__main__":
    main()
