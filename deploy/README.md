# Deploy ke VPS — tanpa domain

VPS: `43.128.104.197` · Ubuntu · Caddy sudah terpasang (masih halaman bawaan)

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
bash deploy/deploy.sh root@43.128.104.197
```

Skrip itu: membuat bundel → mengirim lewat `scp` → menjalankan `install.sh`
di VPS. Total ±5 menit (54 MB unggahan).

**Kalau belum ada SSH key** (kemungkinan besar ini kasusnya — dari laptop ini
belum ada kunci dan `root@43.128.104.197` menolak `publickey`):

```bash
ssh-keygen -t ed25519 -C "laptop-candra"     # tekan Enter terus
ssh-copy-id root@43.128.104.197              # masukkan password VPS sekali
```

Setelah itu perintah deploy bisa diulang kapan saja untuk memperbarui.

### Kalau mau manual

```bash
python scripts/paket_deploy.py               # hasil: _deploy/affiliate-studio.tar.gz
scp _deploy/affiliate-studio.tar.gz deploy/install.sh root@43.128.104.197:/root/
ssh root@43.128.104.197 "bash /root/install.sh /root/affiliate-studio.tar.gz"
```

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

## Verifikasi setelah deploy

```bash
curl -I https://43-128-104-197.sslip.io/          # harus 200, ada Strict-Transport-Security
curl -o /dev/null -w '%{http_code}\n' \
  https://43-128-104-197.sslip.io/data/affiliate.db   # harus 404
curl -s https://43-128-104-197.sslip.io/api/health    # {"ok":true,"rev":...}
```

Lalu buka di browser, cek jadwal posting masih tampil, dan coba buka
`/data/affiliate.db` — harus 404.

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
