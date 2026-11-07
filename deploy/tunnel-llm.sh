#!/usr/bin/env bash
# =============================================================================
# Terowongan balik ke gateway LLM — dijalankan DI LAPTOP, bukan di VPS.
#
#   bash deploy/tunnel-llm.sh            # pakai alias affiliate-vps
#   bash deploy/tunnel-llm.sh ubuntu@43.128.104.197
#
# Kenapa perlu ini
# ----------------
# Gateway LLM Bos ada di 127.0.0.1:20128 di laptop. VPS tidak bisa menjangkau
# alamat lokal laptop, dan laptop tidak punya IP publik. Terowongan ini membuat
# port 20128 DI VPS diteruskan ke port 20128 di laptop, sehingga
# LLM_UPSTREAM=http://127.0.0.1:20128/v1 di VPS benar-benar sampai.
#
# Selama skrip ini hidup, tombol Generate di situs publik berfungsi. Kalau
# dimatikan, situs tetap bisa dibuka dan dijelajahi, tapi Generate menjawab
# "LLM tidak terjangkau" — pesan yang jelas, bukan diam-diam gagal.
#
# Jangan tutup jendela terminal ini saat presentasi.
# =============================================================================
set -uo pipefail

VPS="${1:-affiliate-vps}"
LOCAL_PORT="${LOCAL_PORT:-20128}"
REMOTE_PORT="${REMOTE_PORT:-20128}"

echo "Terowongan LLM: 127.0.0.1:$LOCAL_PORT (laptop)  <->  $VPS:$REMOTE_PORT"
echo "Tekan Ctrl+C untuk berhenti."

while true; do
  printf '[%s] menyambung... ' "$(date +%H:%M:%S)"
  if ssh -N \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -R "$REMOTE_PORT:127.0.0.1:$LOCAL_PORT" "$VPS"; then
    echo "terowongan ditutup."
  else
    echo "gagal (kode $?)."
  fi
  echo "    menyambung ulang dalam 3 detik..."
  sleep 3
done
