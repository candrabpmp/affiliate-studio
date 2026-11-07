---
name: affiliate-video
description: Membuat video pendek untuk produk di Affiliate Studio — ambil draf TikTok, susun prompt video, generate lewat generator video, taruh filenya ke folder produk, lalu verifikasi. This skill should be used when the user asks to make, generate, or redo a product video for the affiliate studio, or says things like "buatkan video untuk <produk>", "generate video HT21", "bikin video iklan produk ini", "video untuk tas trail", "video siap posting". Trigger juga pada: prompt video, storyboard video, video produk, video TikTok affiliate, video 9 detik.
agent_created: true
---

# Affiliate Video

Mengubah draf TikTok yang sudah ada di Affiliate Studio menjadi file video di `data/video/<key produk>/`, sehingga kartu produk langsung berstatus **siap posting**.

Skill ini **tidak menulis ulang logika prompt**. Semua prompt datang dari `studio.py prompt`, yang merupakan port dari `videoPrompt()` di `app.js` dan sudah diverifikasi identik pada 96 kombinasi (4 produk × 4 durasi × 2 rasio × 3 jumlah adegan).

## Lokasi studio

Default: folder induk skill ini (`<studio>/.workbuddy-ai/skills/affiliate-video/` → naik 4 tingkat). Kalau skill dipakai dari folder lain, selalu kirim `--root`:

```bash
python .workbuddy-ai/skills/affiliate-video/scripts/studio.py --root C:/workspace_workbuddy/afiliasi list
```

Semua perintah di bawah memakai `S` sebagai singkatan path script itu.

## Alur

### 1. Cari produknya

```bash
python "$S" list
```

Menampilkan key, nama, status, dan apakah sudah punya video. Kalau user menyebut nama (bukan key), langsung pakai namanya — `find_item` menerima potongan nama dan akan menolak kalau ambigu (bukan menebak).

```bash
python "$S" item "hydropack"        # JSON: hook, storyboard, caption, foto produk
```

### 2. Susun prompt

```bash
python "$S" prompt p19595697771 --dur 9 --ratio 9:16 --scenes auto
```

- `--dur` : `8` | `9` | `10` | `long` (20–30 dtk)
- `--ratio` : `9:16` (TikTok) | `16:9`
- `--scenes` : `auto` | `3` | `4` | `5`

Biarkan `auto` kecuali user minta lain. Untuk 9 detik, `auto` menghasilkan 4 adegan (2,2–2,3 detik/adegan); 5 adegan terlalu padat dan model mulai mengacak isi frame.

### 3. Ambil foto produk untuk frame pertama

```bash
python "$S" asset p45262087324
```

Baris pertama = `assets/<productId>/img-01.jpg`; sisanya (kalau ada) dicetak ke stderr sebagai kandidat lain.

**Periksa gambarnya dulu sebelum dipakai.** `img-01` sering banner promo — latar warna blok dengan tulisan besar "POLYTRON", "SOUND BAR", harga. Dipakai sebagai frame pertama, hasilnya video slide berjalan dengan teks raksasa, bukan rekaman. Yang dicari: foto produk di latar polos atau di lantai/meja, tanpa tulisan menempel.

**Dukungan gambar tergantung model.** `kling-video-v3` (model yang tersedia di sesi ini) menerima **0 reference image** dan hanya bisa text-to-video. Cek dulu sebelum merancang alur yang bergantung pada foto:

- kalau model menerima `reference_images` → pakai foto bersih sebagai acuan, komposisi tetap bebas
- kalau hanya menerima `image` (frame pertama) → hanya cocok untuk video satu shot; storyboard multi-adegan akan terkunci pada foto itu
- kalau tidak menerima gambar sama sekali → text-to-video, dan sebut bentuk produk secara eksplisit di prompt

### 4. Generate

Pakai tool `VideoGen`:

- `prompt` = keluaran langkah 2, apa adanya
- `image` / `reference_images` = keluaran langkah 3, **hanya kalau model mendukung**
- `seconds` = 9 (atau sesuai `--dur`; `long` tidak didukung model, pakai 8–10)
- `aspect_ratio` = `9:16`
- `output_dir` = folder sementara, mis. `data/_tmp_video`

**Batas panjang prompt berbeda per model.** `kling-video-v3` memotong di **2500 karakter**; prompt aplikasi bisa 2.600-an. Pakai `--max` supaya dipangkas berurutan (NARASI → MUSIK → butir ATURAN VISUAL dari bawah) dan tidak gagal di tengah jalan:

```bash
python "$S" prompt p45262087324 --dur 9 --ratio 9:16 --max 2500
```

Yang tidak pernah dipangkas: HOOK, STORYBOARD, TEKS DI LAYAR, CATATAN DURASI, komposisi, dan aturan gambar bersih. Kalau masih tidak muat, script berhenti dengan pesan jelas — lebih baik gagal daripada memotong kalimat di tengah.

**Gerbang biaya — wajib.** Video 5 detik ≈ 50–100 kredit, proses 1–3 menit. Sebelum memanggil `VideoGen`, sampaikan ke user berapa video yang akan dibuat dan perkiraan kreditnya, lalu tunggu persetujuan. Jangan pernah generate lebih dari satu video tanpa izin eksplisit per video.

### 5. Taruh di folder produk

```bash
python "$S" place p19595697771 "data/_tmp_video/hasil.mp4"
```

Menyalin ke `data/video/<key>/<timestamp>.mp4` dengan aturan penamaan yang sama seperti `server.py` (validasi ekstensi, batas 200 MB, sanitasi key). Nama berstempel waktu, jadi versi lama tidak pernah tertimpa.

### 6. Verifikasi

```bash
python "$S" verify
```

`OK` = disk dan database sinkron. `yatim` = file ada tapi belum tercatat (normal tepat setelah `place` — aplikasi mengadopsinya saat halaman dimuat). `hilang` = state mencatat file yang sudah tidak ada di disk.

Aplikasi menjalankan `reconcileVideos()` setiap halaman dimuat, jadi cukup minta user **muat ulang halaman**; badge `video siap` akan muncul sendiri di daftar produk tanpa perlu membuka kartu.

**Video yang ada = konten dianggap disetujui.** Saat halaman dimuat, item TikTok berstatus `belum review` yang sudah punya video otomatis dipindah ke `lolos` dan diberi slot jadwal. Pengecualian: `batal` (pembatalan itu keputusan sadar user) dan konten yang tidak lolos `validateContent` — yang terakhir tetap tertahan dan memunculkan pemberitahuan. Jadi setelah `place`, sebutkan ke user bahwa statusnya akan ikut berubah.

## Batasan generator yang sudah terbukti

Ditemukan dari hasil sungguhan, bukan dugaan:

| Hal | Kenyataan | Tindakan |
|---|---|---|
| Watermark | `kling-video-v3` menempel watermark kecil di sudut kiri atas (teks "AI生成") dan tidak bisa dihilangkan lewat prompt | Sampaikan ke user sebelum posting; opsi: crop tepi, atau pakai model/plan tanpa watermark |
| Teks di layar | Adegan yang menyorot layar (laptop, HP) menghasilkan tulisan acak yang tidak terbaca | Hindari adegan layar di draf, atau terima risikonya — jangan janjikan teks yang bisa dibaca |
| Reference image | `kling-video-v3` tidak menerimanya sama sekali | Jangan andalkan foto produk sebagai acuan; perkuat deskripsi produk di prompt |
| Batas prompt | 2500 karakter | Selalu kirim `--max 2500` |
| Rasio & durasi | Diikuti dengan benar (9:16 → 720x1280, 9 dtk → 9,04 dtk) | Aman |

## Aturan yang tidak boleh dilanggar

1. **Prompt dari draf, bukan karangan.** Jangan menambah klaim produk (harga, garansi, bahan) yang tidak ada di `item`. Kalau draf terasa lemah, perbaiki drafnya di aplikasi dulu, jangan ditambal di prompt.
2. **Periksa klaim teknis di draf terhadap `item.detail` sebelum generate.** Draf ditulis LLM dan bisa mengarang fitur. Contoh nyata: draf speaker pasif Polytron menulis "menyetel musik dengan koneksi bluetooth", padahal produknya speaker pasif berkabel RCA tanpa bluetooth sama sekali. Menghapus klaim palsu dari prompt boleh (itu koreksi, bukan tambahan) — tapi catat di laporan bahwa drafnya sendiri masih salah, karena adegan di aplikasi tidak bisa diedit manual.
2. **Prompt itu positive-only.** Jangan pernah menambahkan kalimat "jangan tampilkan X". Generator video menggambar kata benda yang disebut, bukan maksud kalimatnya — larangan justru memunculkan bendanya. Kalimat larangan yang sudah ada di prompt hanya untuk hal yang tidak bisa digambar sebagai objek (pose jualan, watermark).
3. **Jangan menyebut nama platform** (TikTok, Shopee, Instagram) di dalam prompt. Dulu baris "ruang aman untuk UI TikTok" membuat model menggambar antarmuka TikTok lengkap di detik terakhir.
4. **Satu klip per produk.** Kalau user minta beberapa variasi, generate berurutan dan beri tahu kreditnya per video.
5. **Jangan menghapus video lama.** `place` selalu menambah file baru. Penghapusan hanya lewat UI aplikasi (tombol Hapus di modal Video), supaya user melihat apa yang hilang.
6. **Jangan menyunting database langsung.** Satu-satunya penulisan yang boleh adalah lewat `place` (menulis file), bukan `UPDATE state`.

## Kalau app.js diubah

`studio.py` adalah salinan logika prompt. Setelah mengubah `videoPrompt()`, `vpMergeScenes()`, `vpFitNote()`, `vpFrameNote()`, atau `vpUiNote()` di `app.js`:

1. Jalankan `studio.py prompt <key> --dur 9 --ratio 9:16 --scenes auto`
2. Bandingkan dengan yang tampil di modal **Prompt video** aplikasi
3. Samakan `studio.py` sampai identik

Cara cepat membandingkan banyak kombinasi: buka aplikasi di browser, jalankan di console `videoPrompt(S.items[0], {dur:'9',ratio:'9:16',scenes:'auto'})`, lalu diff dengan keluaran CLI.

## Troubleshooting

| Gejala | Sebab | Tindakan |
|---|---|---|
| `Folder studio tidak ditemukan` | dijalankan dari folder lain | kirim `--root <folder studio>` |
| `Draf TikTok masih kosong` | produk belum digenerate di aplikasi | minta user generate draf TikTok dulu |
| `Nama ... cocok dengan N produk` | nama terlalu umum | pakai key dari `list` |
| `verify` bilang `yatim` | file ditulis tapi state belum tahu | minta user muat ulang halaman aplikasi |
| `verify` bilang `hilang` | file dihapus manual dari folder | muat ulang halaman; state akan dibersihkan |
| Video tetap tidak muncul | halaman belum di-reload | `reconcileVideos()` hanya jalan saat halaman dimuat |
