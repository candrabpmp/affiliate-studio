# Deploy ke VPS — tanpa domain

**Status: sudah terpasang dan live → https://43-128-104-197.sslip.io/**

VPS: `43.128.104.197` · Ubuntu 24.04.4 LTS · Python 3.12.3 · Caddy 2.11.4
User SSH: `ubuntu` (punya `sudo` tanpa password) — **bukan `root`**

---

## Kenapa pakai `sslip.io`, bukan IP langsung

Let's Encrypt tidak menerbitkan sertifikat untuk alamat IP mentah. Tanpa
sertifikat, alamat `http://43.128.104.197` akan tampil **"Not secure"** di
browser — calon juri biasanya langsung menutup tab.

`sslip.io` adalah DNS publik gratis yang selalu menjawab
`<ip-dengan-strip>.sslip.io` dengan IP tersebut:

```
43-128-104-197.sslip.io   ->   43.128.104.197
```

Sudah saya uji, resolve-nya benar. Karena itu nama ini bisa diverifikasi
Let's Encrypt lewat HTTP-01 (port 80 VPS terbuka), sehingga **sertifikat asli
dan diperbarui otomatis** — tanpa beli domain, tanpa Cloudflare.

Kalau nanti sudah punya domain sendiri, cukup ganti satu baris di
`/etc/caddy/Caddyfile` lalu `systemctl reload caddy`.

---

## Deploy — satu perintah

Dari folder proyek, di Git Bash:

```bash
bash deploy/deploy.sh affiliate-vps
# atau tanpa alias: bash deploy/deploy.sh ubuntu@43.128.104.197
```

Skrip itu: membuat bundel → mengirim lewat `scp` ke `/tmp` → menjalankan
`install.sh` lewat `sudo` di VPS. Total ±5 menit (54 MB unggahan).

Alias `affiliate-vps` dibuat sekali di `~/.ssh/config`:

```
Host affiliate-vps
    HostName 43.128.104.197
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519_deploy
    IdentitiesOnly yes
```

Lalu sekali saja, supaya tidak perlu password:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_deploy -N ""
ssh-copy-id -i ~/.ssh/id_ed25519_deploy.pub ubuntu@43.128.104.197
```

### Kalau mau manual

```bash
python scripts/paket_deploy.py               # hasil: _deploy/affiliate-studio.tar.gz
scp _deploy/affiliate-studio.tar.gz deploy/install.sh ubuntu@43.128.104.197:/tmp/
ssh ubuntu@43.128.104.197 \
  "sudo bash /tmp/install.sh /tmp/affiliate-studio.tar.gz 43-128-104-197.sslip.io"
```

Argumen ketiga penting: `sudo VAR=nilai bash ...` tidak selalu meneruskan
environment, tergantung setelan `sudoers`. Karena itu alamat situs dikirim
sebagai argumen, bukan variabel.

---

## Apa yang dipasang

| Lokasi | Isi |
|---|---|
| `/opt/affiliate-studio/` | aplikasi, `assets/`, `data/affiliate.db` |
| `/opt/affiliate-studio/.env` | `AFFILIATE_HOST`, `PORT`, `ORIGIN` (mode 640, milik root) |
| `/etc/systemd/system/affiliate-studio.service` | layanan, auto-restart |
| `/etc/caddy/Caddyfile` | TLS otomatis + reverse proxy |

Server Python **tetap di `127.0.0.1:8787`** — hanya Caddy yang menghadap
internet. Port 8787 tidak terbuka, jadi tidak ada jalan memutar melewati TLS.

---

## Yang sudah diperbaiki sebelum naik ke internet

Tiga hal ini tadinya tidak berbahaya di localhost, tapi jadi masalah begitu
alamatnya publik. Semua sudah diuji ulang (lihat `server.py`):

1. **Berkas sensitif bisa diunduh.** Dulu seluruh folder proyek disajikan apa
   adanya: `GET /data/affiliate.db` → 200 (4,2 MB, berisi API key),
   `GET /.git/config` → 200, `GET /server.py` → 200.
   Sekarang ada daftar putih ekstensi — kedelapan jalur sensitif itu
   dijawab **404**, sementara `index.html`, `app.js`, `styles.css`,
   `assets/` tetap 200.
2. **CORS hanya untuk localhost.** Sekarang origin asli didaftarkan lewat
   `AFFILIATE_ORIGIN`; origin asing ditolak (diuji: `http://jahat.example`
   tidak menerima header izin).
3. **API key ikut terbang di bundel.** Pengosongan kolom saja tidak cukup —
   SQLite menandai halaman lama sebagai bebas tanpa menghapus isinya, jadi
   key masih terbaca dengan `grep` pada berkas mentah (terbukti: 63 kemunculan).
   Sekarang salinan dibuat lewat backup API + `secure_delete` + `VACUUM`:
   **0 kemunculan**, database mengecil 4,2 MB → 0,12 MB.

---

## Satu hal yang perlu diputuskan: LLM

Ini bukan soal deploy, tapi menentukan apakah juri melihat 3 agen bekerja.

`pengaturan.js` menunjuk ke `http://localhost:20128/v1` — gateway LLM di
laptop Bos. Di VPS, `localhost` adalah VPS itu sendiri, dan di sana tidak ada
apa pun yang mendengarkan di port 20128. Akibatnya:

> Tanpa LLM, tombol **Generate** akan menolak dengan
> *"LLM belum dikonfigurasi"* (`runAgentPipeline` mensyaratkannya di baris
> pertama). Jadwal, produk, dan data demo tetap tampil — tapi pipeline
> Planner → Writer → Reviewer tidak bisa dijalankan.

Tiga pilihan:

| Cara | Kapan cocok | Konsekuensi |
|---|---|---|
| **A. Biarkan mati** | Juri hanya perlu melihat aplikasi + video demo | Paling aman, tapi agen tidak bisa dicoba langsung |
| **B. Endpoint `/api/generate` di server** | Juri perlu mencoba sendiri | Perlu kerja tambahan: panggilan LLM pindah dari browser ke server, key disimpan di `.env` VPS. Ini juga yang dibutuhkan untuk multi-user ("API disediakan platform") |
| **C. Tunnel ke laptop** | Demo terjadwal, laptop pasti nyala | `ssh -R 20128:localhost:20128` — rapuh, jangan dipakai untuk penjurian |

**Rekomendasi saya: B.** Itu satu-satunya jalan yang sekaligus menyelesaikan
masalah key (key tidak pernah sampai ke browser), dan sesuai arah multi-user
yang Bos sebutkan. Ukurannya sedang: satu endpoint + pemindahan pemanggilan
LLM dari `agents.js` ke server.

---

## Hasil verifikasi (diukur dari luar VPS, 7 Nov 2026)

| Uji | Hasil |
|---|---|
| `GET /` | **200** |
| `GET /app.js`, `/agents.js`, `/styles.css`, `/assets/manifest.js` | **200** |
| `GET /data/affiliate.db` | **404** |
| `GET /.env`, `/server.py`, `/.git/config`, `/deploy/Caddyfile` | **404** |
| `GET /api/health` | `{"ok":true,"rev":281}` — data demo utuh |
| `http://` (port 80) | **308** → dialihkan ke HTTPS |
| Sertifikat | `CN=43-128-104-197.sslip.io`, valid 7 Nov 2026 – 5 Feb 2027 |
| Port 8787 | hanya `127.0.0.1`, tidak terbuka ke internet |
| Render di browser | 13 produk, status review, chip agen, `rev 281` tampil |

Perintah untuk mengulang pemeriksaan kapan saja:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://43-128-104-197.sslip.io/
curl -s -o /dev/null -w '%{http_code}\n' https://43-128-104-197.sslip.io/data/affiliate.db
curl -s https://43-128-104-197.sslip.io/api/health
```

---

## Perawatan

```bash
journalctl -u affiliate-studio -f      # log aplikasi
journalctl -u caddy -f                 # log TLS / akses
systemctl restart affiliate-studio     # mulai ulang
```

**Cadangan harian** (pasang sekali):

```bash
apt-get install -y sqlite3
mkdir -p /var/backups/affiliate
crontab -e
# tambahkan:
0 3 * * * sqlite3 /opt/affiliate-studio/data/affiliate.db ".backup '/var/backups/affiliate/$(date +\%F).db'"
```

`install.sh` bersifat idempoten: **`data/` dan `.env` lama tidak pernah
ditimpa** saat deploy ulang, jadi data demo aman.

---

## Dua bug yang muncul saat deploy pertama

Dicatat supaya tidak terulang:

1. **`str(Path)` menghasilkan backslash di Windows.** Arsip berisi entri
   bernama `deploy\Caddyfile` — satu berkas dengan backslash di namanya,
   bukan direktori `deploy/`. Akibatnya `install.sh` gagal di langkah 5
   (`cannot stat .../deploy/affiliate-studio.service`) dan seluruh berkas
   `deploy/` serta `assets/` mendarat di akar sebagai nama aneh.
   Perbaikan: `p.relative_to(ROOT).as_posix()`.
2. **Email ACME placeholder ditolak.** `admin@example.com` membuat Let's
   Encrypt menjawab `invalidContact :: contact email has forbidden domain
   "example.com"`. Caddy lalu beralih ke ZeroSSL dan tetap berhasil, tapi
   log jadi berisik. Perbaikan: email dikosongkan — sertifikat tetap terbit.

## Kalau sertifikat gagal

Gejala: `https://43-128-104-197.sslip.io` menggantung atau `ERR_CERT`.

```bash
journalctl -u caddy -n 40
```

Penyebab paling umum:

- **Port 80 tertutup di security group penyedia VPS.** Let's Encrypt harus
  bisa menghubungi port 80 dari internet. Buka di panel Alibaba Cloud /
  penyedia masing-masing, bukan hanya di `ufw`.
- **A record belum menyebar.** `nslookup 43-128-104-197.sslip.io` harus
  menjawab `43.128.104.197`.
- **Caddy belum di-reload** setelah Caddyfile diganti.
