#!/usr/bin/env bash
# =============================================================================
# Deploy dari laptop ke VPS — satu perintah.
#
#   bash deploy/deploy.sh root@43.128.104.197
#
# Yang dilakukan: bikin bundel -> kirim lewat scp -> jalankan install.sh di VPS.
# Butuh SSH key (atau akan diminta password). Kalau belum punya key:
#
#   ssh-keygen -t ed25519 -C "laptop"     # enter terus
#   ssh-copy-id root@43.128.104.197       # masukkan password sekali
#
# Setelah itu perintah di atas bisa diulang kapan saja untuk memperbarui.
# =============================================================================
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Pakai: bash deploy/deploy.sh root@43.128.104.197"
  exit 1
fi

SITE_ADDRESS="${SITE_ADDRESS:-cpak.my.id}"
cd "$(dirname "$0")/.."

echo "== 1/4 memeriksa koneksi ke $TARGET"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$TARGET" 'echo ok' >/dev/null 2>&1; then
  echo "   Belum bisa masuk tanpa password. Mencoba dengan password (sekali saja)..."
  ssh -o ConnectTimeout=8 "$TARGET" 'echo ok' || {
    echo "   Gagal masuk. Siapkan SSH key dulu: ssh-copy-id $TARGET"
    exit 1
  }
fi
echo "   ok"

echo "== 2/4 membuat bundel"
python scripts/paket_deploy.py

echo "== 3/4 mengirim ke VPS"
# /tmp, bukan /root — user biasa (mis. 'ubuntu') tidak boleh menulis ke /root.
scp -q _deploy/affiliate-studio.tar.gz deploy/install.sh "$TARGET:/tmp/"
echo "   ok"

echo "== 4/4 memasang di VPS"
ssh "$TARGET" "sudo bash /tmp/install.sh /tmp/affiliate-studio.tar.gz $SITE_ADDRESS"

echo
echo "Selesai. Buka: https://$SITE_ADDRESS/"
