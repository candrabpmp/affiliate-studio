# Pengumpulan — AI CAN DO IT, Tencent Cloud Hackathon Indonesia 2026

Tantangan C · Agen Kreator. Semua berkas pengumpulan ada di folder ini.

## Peta persyaratan → berkas

| Persyaratan panduan | Status | Berkas |
|---|---|---|
| Judul proyek | siap | `DESKRIPSI-PROYEK.md` (tabel atas) |
| Blurb singkat (maks 10 kata) | siap | "Tiga agent menulis konten, menolak klaim melanggar, manusia memutuskan." |
| Deskripsi proyek | siap | `DESKRIPSI-PROYEK.md` (versi panjang, untuk repo) · **`DESKRIPSI-SINGKAT.txt`** (4.333 karakter, siap tempel ke textbox) · `DESKRIPSI-PADAT.txt` (1.892 karakter, kalau kolomnya pendek) |
| **Lembar akuntabilitas** | siap | `LEMBAR-AKUNTABILITAS.md` |
| **Hasil pengujian + screenshot** | siap | `hasil-pengujian.html` · `results.json` · `screenshot-hasil.png` |
| Diagram arsitektur | siap | `arsitektur.svg` · `arsitektur.png` |
| Video demo 5–8 menit | **terekam, belum final** | `demo-afiliasi.mp4` — 11:04, 1276×1354, **tanpa narasi**, 589 MB. Alur penolakan R-02 sudah terekam (lihat `SKRIP-DEMO.md` untuk sisa yang perlu dirapikan) |
| Berbagi produk (nilai WorkBuddy) | siap | `DESKRIPSI-PROYEK.md` §8 |
| Source code | **perlu dipublikasikan** | repo ini; lihat "Yang masih perlu Bos kerjakan" |
| Gambar sampul 16:9 (**380×216**) | siap | `sampul-v1-380x216.png` (gelap) · `sampul-v2-380x216.png` (isometrik) · `sampul-v3-380x216.png` (tanpa identitas hackathon). Versi 3× `sampul-v{1,2,3}-1140x648.png` untuk unggahan tajam. Sumber `sampul-380.html` · prompt `PROMPT-SAMPUL.md` |
| Tautan proyek (bonus) | belum | perlu hosting |

## Cara menjalankan ulang pengujian

```bash
# server harus hidup di 8787
node hackathon/run-tests.js
```

Butuh Playwright + Chrome. Keluaran: `results.json`, `hasil-pengujian.html`, `screenshot-hasil.png`. Exit code 1 kalau ada kasus gagal — sengaja, supaya tidak bisa "lulus diam-diam".

## Angka yang boleh dikutip

- **20/20 kasus lulus**, setelah 5 kasus gagal pada percobaan pertama dan 4 cacat rulebook diperbaiki (rincian di bawah).
- **8 aturan** bernomor di `rulebook.js`, masing-masing dengan dasar hukum, penjelasan, dan cara perbaikan.
- **3 iterasi** maksimum sebelum eskalasi ke manusia.
- **3 agent** terlihat bekerja: Planner → Writer → Reviewer, dengan durasi masing-masing tercatat (contoh nyata: 6,2 dtk · 7,1 dtk · 2,2 dtk).
- **10 slot jadwal** aktif, maksimum 2 per platform per hari.

## Cacat yang ditemukan lewat pengujian (jangan dihapus dari cerita)

| Kasus | Gejala | Sebab sebenarnya |
|---|---|---|
| TC-06 | "BPOM" tidak tertangkap | Gerbang sumber satu regex untuk semua pola — kata "original" di sumber ikut membenarkan klaim "BPOM" |
| TC-18 | "100%" tidak tertangkap | `\b100%\b` tidak pernah cocok: `%` bukan karakter kata, jadi batas kata di belakangnya mustahil |
| TC-01 | "paling bikin" dianggap superlatif | Pola `paling\s+\w+` terlalu luas, menangkap kata kerja |
| TC-12/13 | Frasa klise & emoji jadi **blocking** | `validateContent` memeriksa hal yang sama; satu pelanggaran dihitung dua kali dengan bobot berbeda |
| TC-04 | Dua aturan menyala bersamaan | **Ekspektasi tesnya yang salah**, bukan aturannya — R-03 dan R-05 memang berlaku untuk "100% halal" |

Satu cacat lagi ditemukan saat memeriksa kode, bukan saat menguji: **R-07 memeriksa draf lama yang tersimpan**, bukan draf yang sedang dinilai. Artinya aturan format bisa meloloskan draf yang sebenarnya melanggar. Diperbaiki dengan menukar sementara isi platform saat penilaian.

## Yang masih perlu Bos kerjakan

1. **Rekam video demo** mengikuti `SKRIP-DEMO.md` (5–8 menit, wajib).
2. **Publikasikan repo** (wajib). Repo lokal sudah siap dan sudah di-commit
   (`main`, 181 berkas, `data/` dan video tidak ikut). Yang tersisa hanya
   autentikasi:
   ```bash
   # setelah gh terpasang dan login
   gh repo create affiliate-studio --public --source=. --push
   ```
   Tanpa `gh`: buat repo kosong di github.com/new, lalu
   `git remote add origin <url>` dan `git push -u origin main`.
   Sebelum push, ganti identitas commit: `git config user.name "..."`,
   `git config user.email "..."`, lalu `git commit --amend --reset-author --no-edit`.
3. **Tautan proyek** (bonus, opsional): aplikasi ini butuh server lokal, jadi tidak bisa langsung di-hosting statis. Kalau mau dikejar, bagian demo yang paling aman adalah halaman `hasil-pengujian.html`.
