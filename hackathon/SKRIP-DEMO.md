# Skrip video demo — 7 menit

**Durasi target: 5–8 menit.** Panduan mewajibkan minimal satu kondisi saat agent **menolak**, **meminta klarifikasi**, atau **menunggu persetujuan**. Video ini menampilkan dua di antaranya: penolakan dan persetujuan manusia.

Siapkan sebelum merekam: server hidup (`mulai.bat`), satu produk dengan detail sudah diekstrak, tab Review dalam keadaan bersih.

---

## 0:00 – 0:45 · Masalahnya

**Layar:** tab Data Produk, satu product sheet terbuka (spesifikasi, deskripsi seller).

> "Penjual online punya satu product sheet dan harus mengubahnya jadi utas Threads dan naskah TikTok. Model bahasa bisa melakukannya dalam hitungan detik — dan di situ masalahnya mulai. Deskripsi seller penuh bahasa iklan: '100% tahan air', 'BPOM', 'garansi seumur hidup'. Model akan mengulanginya sebagai fakta, dan yang menanggung risikonya afiliatornya, bukan penjualnya."

**Tunjuk** satu baris klaim di deskripsi seller.

> "Klaim seperti ini yang harus ditangkap sebelum konten terbit — bukan sesudah ditarik."

## 0:45 – 1:30 · Apa yang dibangun

**Layar:** diagram arsitektur (`arsitektur.svg`).

> "Tiga agent dengan wewenang terpisah. Planner menyusun brief dan batas klaim. Writer menulis — dan tidak berwenang menilai. Reviewer menilai — dan tidak menulis. Di antara mereka ada trust boundary: semua yang menyeberang ke bawah hanya usulan, tidak pernah tindakan."

**Tunjuk** kotak `rulebook.js`.

> "Dan yang paling penting: aturannya bukan di dalam prompt. Ada di berkas terpisah, delapan aturan bernomor, dengan dasar hukum dan cara perbaikannya. Aturan yang tersembunyi di prompt tidak bisa diaudit. Berkas bisa dibaca, di-diff, dan dipertanggungjawabkan."

## 1:30 – 2:30 · Menjalankan pipeline

**Layar:** tab Review, tekan **Regenerate** pada satu produk Threads.

> "Satu tekan. Planner membaca product sheet dan menyusun brief — termasuk daftar klaim yang dilarang untuk produk ini. Writer menulis dari brief itu."

**Tunggu**, lalu buka panel **Jejak agent**.

> "Ini yang membedakan dari chatbot: setiap langkah tercatat. Siapa bilang apa, di iterasi ke berapa."

**Buka** baris Writer.

> "Draf lengkapnya tersimpan, bukan cuma hasil akhirnya."

## 2:30 – 4:00 · Agent menolak (wajib)

**Layar:** kotak skrip kedua — siapkan produk uji dengan klaim "maag saya sembuh total" di deskripsi seller.

> "Sekarang saya masukkan product sheet yang deskripsi sellernya berisi testimoni: 'maag saya sembuh total'. Ini persis kasus uji di panduan."

**Tekan Regenerate**, tunggu, buka Jejak agent.

> "Reviewer menolak. Perhatikan bentuk penolakannya: bukan 'konten tidak sesuai', tapi **R-02 — klaim kesehatan dan penyembuhan dilarang**, dengan kutipan persisnya, dan cara perbaikannya. Itu sebabnya Writer bisa memperbaiki tanpa menebak."

**Tunjuk** iterasi.

> "Draf dikembalikan, Writer menulis ulang, Reviewer menilai lagi. Maksimal tiga kali. Kalau masih melanggar, pipeline berhenti dan menyerahkan sisanya ke manusia — tidak ada perulangan tanpa batas."

## 4:00 – 5:00 · Bukti bahwa aturannya bekerja

**Layar:** `hackathon/hasil-pengujian.html`.

> "Dua puluh kasus uji, dijalankan terhadap Reviewer yang sesungguhnya — bukan tiruan. Yang penting bukan angka 20 dari 20, tapi bahwa lima kasus **gagal** di percobaan pertama."

**Scroll** ke baris TC-06 dan TC-18.

> "BPOM lolos karena gerbang sumbernya terlalu longgar. '100%' tidak pernah tertangkap karena batas kata di regex tidak pernah cocok dengan tanda persen. Keduanya cacat aturan, bukan cacat model. Kami perbaiki aturannya, bukan tesnya — dan satu kasus, TC-04, memang ekspektasi tesnya yang salah, jadi itu yang kami betulkan."

> "Lima dari dua puluh kasus juga sengaja berisi draf yang **harus lolos**. Sistem yang menolak semuanya tidak berguna."

## 5:00 – 6:00 · Manusia memutuskan (wajib)

**Layar:** kartu review dengan status **eskalasi**.

> "Ketika tiga iterasi habis dan pelanggaran masih ada, tombol Lolos tidak berfungsi. Bukan karena bug — karena persetujuan manusia tidak ada artinya kalau manusia bisa menekan tombol apa pun."

**Tekan** tombol Lolos → tolak. Lalu **Setujui dengan catatan**.

> "Satu-satunya jalan adalah override, dan override mewajibkan alasan tertulis. Alasan itu masuk ke jejak agent dan tidak bisa dihapus."

**Isi** alasan, tunjukkan baris `HUMAN` muncul di jejak.

> "Ini yang membuat keputusan bisa dipertanggungjawabkan enam bulan kemudian."

## 6:00 – 6:45 · Penjadwalan

**Layar:** tab Penjadwalan.

> "Konten yang lolos otomatis dapat slot. Jam puncak audiens, bukan jam laptop — WIB, WITA, WIT, dihitung lewat konversi zona yang benar, bukan tambah tujuh jam. Cooldown empat belas hari per produk, satu tayangan per jendela. Sabtu TikTok digeser satu jam lebih awal karena puncaknya lebih awal."

## 6:45 – 7:00 · Refleksi

> "Dua hal yang saya pelajari. Pertama: yang membuat agent bisa dipercaya bukan model yang lebih pintar, tapi **aturan yang bisa dikutip**. Kedua: pengujian menemukan empat cacat yang tidak akan pernah saya temukan dengan membaca kode — termasuk aturan format yang ternyata memeriksa draf lama, bukan draf yang sedang dinilai."

> "Yang belum selesai: auto-post masih simulasi, tidak ada integrasi API resmi. Saya sebut apa adanya, karena menyembunyikannya lebih mahal daripada mengakuinya."

---

## Daftar bidikan (untuk editing)

| Menit | Bidikan | Berkas |
|---|---|---|
| 0:00 | Product sheet + klaim seller | tab Data Produk |
| 0:45 | Diagram arsitektur | `hackathon/arsitektur.png` |
| 1:30 | Generate + Jejak agent | tab Review (Threads) |
| 2:30 | Penolakan R-02 | Jejak agent, produk uji |
| 4:00 | Tabel 20 kasus | `hackathon/hasil-pengujian.html` |
| 5:00 | Override + alasan | kartu review |
| 6:00 | Jadwal prime | tab Penjadwalan |
