#!/usr/bin/env bash
# =============================================================================
# Pemasangan Affiliate Studio di VPS Ubuntu — dijalankan SEBAGAI ROOT di VPS.
# Tidak perlu dijalankan manual kalau memakai deploy/deploy.sh dari laptop.
#
#   bash install.sh /root/affiliate-studio.tar.gz
#
# Skrip ini idempoten: menjalankan dua kali tidak merusak data yang sudah ada.
# Data lama (data/ dan .env) sengaja DIPERTAHANKAN saat pemasangan ulang.
# =============================================================================
set -euo pipefail

TARBALL="${1:-/root/affiliate-studio.tar.gz}"
APP_DIR=/opt/affiliate-studio
SERVICE=affiliate-studio
# Alamat situs bisa diberikan sebagai argumen kedua, karena `sudo VAR=nilai
# bash ...` tidak selalu meneruskan environment tergantung setelan sudoers.
SITE_ADDRESS="${2:-${SITE_ADDRESS:-43-128-104-197.sslip.io}}"

say() { printf "\n\033[1;36m== %s\033[0m\n" "$*"; }
ok()  { printf "   \033[1;32mok\033[0m %s\n" "$*"; }
warn(){ printf "   \033[1;33m!\033[0m %s\n" "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Jalankan sebagai root (sudo bash install.sh)"; exit 1; }
[ -f "$TARBALL" ] || { echo "Bundel tidak ditemukan: $TARBALL"; exit 1; }

# ----------------------------------------------------------------- 1. paket dasar
say "1/8 paket dasar"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 curl ca-certificates tar >/dev/null
ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"

# ----------------------------------------------------------------- 2. pengguna
say "2/8 pengguna sistem"
if id affiliate >/dev/null 2>&1; then
  ok "pengguna 'affiliate' sudah ada"
else
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin affiliate
  ok "pengguna 'affiliate' dibuat"
fi

# ----------------------------------------------------------------- 3. berkas
say "3/8 mengekstrak bundel"
mkdir -p "$APP_DIR"
EXCLUDES=()
if [ -d "$APP_DIR/data" ]; then
  EXCLUDES+=(--exclude='./data/*')
  warn "data/ lama dipertahankan (tidak ditimpa bundel)"
fi
if [ -f "$APP_DIR/.env" ]; then
  EXCLUDES+=(--exclude='./.env')
  warn ".env lama dipertahankan"
fi
tar -xzf "$TARBALL" -C "$APP_DIR" "${EXCLUDES[@]}"
mkdir -p "$APP_DIR/data" "$APP_DIR/assets"
ok "$(find "$APP_DIR" -maxdepth 1 -type f | wc -l) berkas di $APP_DIR"

# ----------------------------------------------------------------- 4. .env
say "4/8 konfigurasi"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<EOF
AFFILIATE_HOST=127.0.0.1
AFFILIATE_PORT=8787
AFFILIATE_ORIGIN=https://$SITE_ADDRESS
PYTHONDONTWRITEBYTECODE=1
EOF
  ok ".env dibuat"
else
  # pastikan origin mengikuti nama situs yang dipakai
  if grep -q '^AFFILIATE_ORIGIN=' "$APP_DIR/.env"; then
    sed -i "s|^AFFILIATE_ORIGIN=.*|AFFILIATE_ORIGIN=https://$SITE_ADDRESS|" "$APP_DIR/.env"
  else
    echo "AFFILIATE_ORIGIN=https://$SITE_ADDRESS" >> "$APP_DIR/.env"
  fi
  ok ".env disesuaikan (origin -> https://$SITE_ADDRESS)"
fi
chown -R affiliate:affiliate "$APP_DIR"
chmod 640 "$APP_DIR/.env"
chown root:affiliate "$APP_DIR/.env"

# ----------------------------------------------------------------- 5. systemd
say "5/8 layanan systemd"
install -m 644 "$APP_DIR/deploy/affiliate-studio.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE aktif"
else
  warn "$SERVICE gagal start — lihat: journalctl -u $SERVICE -n 40"
fi

# ----------------------------------------------------------------- 6. caddy
say "6/8 Caddy (HTTPS otomatis)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  ok "caddy dipasang"
else
  ok "caddy sudah ada ($(caddy version | awk '{print $1}'))"
fi

# Alamat situs dijadikan harfiah supaya berkas di VPS mudah dibaca.
sed "s|{\$SITE_ADDRESS:43-128-104-197.sslip.io}|$SITE_ADDRESS|g" \
  "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  ok "Caddyfile valid"
else
  warn "Caddyfile tidak valid — periksa: caddy validate --config /etc/caddy/Caddyfile"
fi
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "Caddy dimuat ulang"

# ----------------------------------------------------------------- 7. firewall
say "7/8 firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ufw: 22, 80, 443 dibuka"
else
  warn "ufw tidak aktif — pastikan port 80 & 443 terbuka di security group penyedia VPS"
fi

# ----------------------------------------------------------------- 8. verifikasi
say "8/8 verifikasi"
sleep 1
HEALTH=$(curl -fsS --max-time 5 http://127.0.0.1:8787/api/health 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then ok "server lokal: $HEALTH"; else warn "server lokal tidak menjawab"; fi

for i in 1 2 3 4 5 6 7 8 9 10; do
  CODE=$(curl -o /dev/null -s -w '%{http_code}' --max-time 8 "https://$SITE_ADDRESS/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    ok "https://$SITE_ADDRESS/ -> 200"
    break
  fi
  sleep 3
  [ "$i" = "10" ] && warn "https belum 200 (kode $CODE) — sertifikat mungkin masih diproses; cek: journalctl -u caddy -n 30"
done

cat <<EOF

  Selesai.

  Alamat      : https://$SITE_ADDRESS/
  Log server  : journalctl -u $SERVICE -f
  Log caddy   : journalctl -u caddy -f
  Mulai ulang : systemctl restart $SERVICE

EOF
