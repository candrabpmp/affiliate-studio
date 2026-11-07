# Affiliate Studio

Studio konten afiliasi lokal: satu *product sheet* Shopee menjadi utas Threads
dan naskah video TikTok — ditulis tiga agent, diperiksa aturan yang bisa
diaudit, lalu diputuskan manusia.

> Tiga agent menulis konten, menolak klaim melanggar, manusia memutuskan.

## Masalahnya

Konten afiliasi bukan soal kekurangan ide. Model bahasa tidak pernah kehabisan
ide — dia kehilangan **disiplin**. Kalimat-kalimat ini diambil apa adanya dari
deskripsi penjual di data uji:

- "100% tahan air"
- "BPOM"
- "bikin maag sembuh"

Kalau kalimat itu ikut masuk ke konten, yang menanggung akibatnya bukan model,
tapi orang yang memposting. Dan tidak ada satu pun jejak yang bisa ditunjukkan
untuk membuktikan dari mana klaim itu berasal.

## Cara kerjanya

Tiga agent, wewenangnya dipisah supaya tidak ada yang bisa menilai pekerjaannya
sendiri:

| Agent | Tugas | Tidak berhak |
|---|---|---|
| **Planner** | membaca product sheet, menyusun brief + batas klaim | menulis |
| **Writer** | menulis draf sesuai brief | menilai drafnya sendiri |
| **Reviewer** | menilai draf, dua lapis | menulis |

Reviewer bekerja dua lapis:

1. **Mesin aturan** (`rulebook.js`) — 8 aturan bernomor, deterministik, tidak
   bisa di-*prompt-inject*. Setiap aturan membawa tingkat bahaya, dasar hukum,
   penjelasan, dan cara memperbaiki.
2. **Lapis LLM** — menangkap pelanggaran yang lolos dari pola.

**Kalau keduanya berselisih, lapis 1 yang menang.** ID aturan yang tidak ada di
`rulebook.js` dibuang, jadi model tidak bisa mengarang aturan baru.

Kalau draf masih melanggar setelah **3 iterasi**, pipeline berhenti dan status
menjadi `escalated`. Tombol "Lolos" tidak berfungsi pada draf itu — satu-satunya
jalan adalah *override* dengan **alasan tertulis**, yang tersimpan permanen di
jejak audit dan tidak bisa dihapus.

Aturan sengaja disimpan sebagai berkas, bukan ditanam di dalam prompt. Aturan
yang hidup di dalam prompt tidak bisa diperiksa siapa pun, termasuk yang
menulisnya.

## Menjalankan

```bash
python server.py
# buka http://127.0.0.1:8787/
```

Tidak ada dependensi pihak ketiga — hanya modul bawaan Python. Data tersimpan
di `data/affiliate.db` (SQLite), tidak di browser.

Di Windows bisa juga klik `mulai.bat`.

**API key LLM jangan diisi di `pengaturan.js`.** Isi lewat halaman Pengaturan;
key tersimpan di `data/` yang tidak ikut di-commit.

## Struktur

```
server.py          server HTTP + SQLite, tanpa dependensi
app.js             UI dan alur kerja
agents.js          orkestrasi Planner → Writer → Reviewer
rulebook.js        8 aturan, masing-masing dengan dasar hukum
styles.css         tampilan
index.html         halaman aplikasi
scripts/           pengambilan data produk dari product sheet
assets/            media produk (gambar + video) untuk demo offline
hackathon/         seluruh berkas pengumpulan + hasil pengujian
```

## Pengujian

20 kasus uji, termasuk **5 kontrol negatif** yang harus **lulus** — sistem yang
menolak segalanya juga akan lulus 20/20, dan itu bukan sistem yang pintar.

```bash
python server.py          # di jendela lain
node hackathon/run-tests.js
```

Hasil terakhir: **20/20 lulus**. Rincian, screenshot, dan daftar cacat yang
ditemukan selama pengujian ada di `hackathon/README.md`.

## Batas yang diakui

- **Auto-post masih simulasi.** Tidak ada koneksi ke API Threads atau TikTok.
- **Satu sumber data.** Hanya product sheet Shopee; belum ada pembanding harga.
- **Kontradiksi antar-sumber belum ditandai.** Kalau deskripsi penjual menyebut
  dua merek berbeda, sistem memilih satu tanpa memberi peringatan.
- **`GET /api/state` mengembalikan API key.** Aman selama server hanya
  mendengarkan di `127.0.0.1`, tapi harus diperbaiki sebelum dipasang publik.

## Berkas pengumpulan

Lihat `hackathon/` — deskripsi proyek, lembar akuntabilitas, hasil pengujian,
diagram arsitektur, sampul, dan skrip video demo.
