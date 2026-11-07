# Affiliate Studio — deskripsi proyek

**Tantangan C · Agen Kreator**

| Item | Isi |
|---|---|
| **Judul proyek** | Affiliate Studio — tim agent konten dengan aturan yang bisa dikutip |
| **Blurb (10 kata)** | Tiga agent menulis konten, menolak klaim melanggar, manusia memutuskan. |
| **Kategori** | Agen Kreator (Tantangan C) |
| **Platform** | WorkBuddy (Tencent Cloud) · aplikasi lokal Python + JavaScript |

---

## 1. Masalah nyata

Penjual online di Indonesia bekerja dengan satu product sheet dan harus mengubahnya menjadi banyak format: utas Threads, naskah video TikTok, caption, judul marketplace. Model bahasa bisa melakukannya dalam hitungan detik — dan di situlah masalahnya mulai.

Tiga kegagalan yang kami temui berulang kali saat membangun alat ini:

1. **Klaim yang tidak ada di sumber.** Deskripsi seller sering memuat bahasa iklan ("100% tahan air", "BPOM", "garansi seumur hidup"). Model yang membaca deskripsi itu akan mengulanginya sebagai fakta. Afiliator yang menanggung risikonya, bukan penjual.
2. **Klaim kesehatan.** Untuk produk yang sama sekali bukan obat, model tetap menulis "bikin maag sembuh". Ini persis kasus uji di panduan, dan ini pelanggaran yang paling mahal akibatnya.
3. **Tidak ada jejak.** Ketika konten ditolak atau ditarik, tidak ada cara menjawab pertanyaan sederhana: *siapa yang memutuskan ini layak, dan atas dasar apa?*

Chatbot satu langkah tidak bisa menjawab ketiganya, karena penilaian dilakukan oleh pihak yang sama yang menulis.

## 2. Skenario yang dipilih

**Peluncuran produk:** satu product sheet menjadi konten Threads dan TikTok.

Bukan contoh sintetis — sistem berjalan pada 7 produk Shopee sungguhan dengan detail yang diekstrak dari halaman produk (spesifikasi, deskripsi seller, varian, ongkir), dan video TikTok yang benar-benar dihasilkan untuk salah satunya.

## 3. Target pengguna

Afiliator perorangan dan penjual kecil yang mengelola 5–50 produk sendiri, tanpa tim editorial, tanpa penasihat hukum, dan tanpa waktu memeriksa setiap draf terhadap aturan iklan.

## 4. Insight utama

> Persetujuan manusia tidak ada artinya kalau manusia tidak punya bahan untuk tidak setuju.

Kebanyakan alat "human-in-the-loop" menaruh tombol Setujui di atas teks yang sudah jadi. Manusia menekannya karena tidak ada cara lain. Yang membuat persetujuan bermakna adalah **catatan penolakan yang bisa dibaca**: aturan mana yang dilanggar, kutipan persisnya, dan apa yang harus diperbaiki. Itu sebabnya produk ini dibangun di sekitar satu berkas bernama `rulebook.js`, bukan di sekitar prompt.

## 5. Desain solusi

### Bisnis
- Satu product sheet → dua platform, satu alur.
- Aturan ditulis sebagai **dokumen** (`rulebook.js`, 8 aturan bernomor dengan dasar hukum), bukan disembunyikan di dalam prompt. Aturan bisa ditinjau, di-diff, dan diubah oleh manusia yang bertanggung jawab.
- Penolakan selalu disertai cara perbaikan, sehingga siklus tolak → perbaiki berhenti sendiri, bukan berputar.

### Teknis
- **Tiga agent dengan wewenang terpisah**: Planner (menyusun brief & batas klaim), Writer (menulis, tidak berwenang menilai), Reviewer (menilai, tidak menulis).
- **Reviewer dua lapis**: mesin aturan deterministik (tidak bisa dibujuk prompt) + LLM untuk pelanggaran yang lolos dari pola. Bila berselisih, mesin aturan menang.
- **Batas 3 iterasi**, lalu berhenti dan menyerahkan sisa masalah ke manusia.
- **Jejak agent** disimpan per platform: siapa bilang apa, aturan mana, iterasi ke berapa, dan berapa detik tiap agent bekerja.
- **Indikator langkah hidup**: selama pipeline berjalan, tiga chip (Planner › Writer › Reviewer) menyala berurutan dari callback sungguhan — bukan timer. Selesai generate, durasi tiap agent tertinggal di jejak, sehingga sifat tiga-agent terbaca bahkan dari screenshot statis.
- **Zona waktu audiens** (WIB/WITA/WIT) dihitung lewat `Intl.DateTimeFormat` dengan konversi dua lintasan, bukan offset hardcode.
- Data lokal: SQLite satu baris status + berkas video di disk, dengan penguncian optimistis (`rev`) supaya dua tab tidak saling menimpa.

## 6. Peran prompt

Prompt **bukan** tempat aturan. Prompt hanya membentuk suara dan struktur:

| Agent | Prompt menentukan | Prompt **tidak** menentukan |
|---|---|---|
| Planner | Cara membaca product sheet, format brief | Apa yang boleh diklaim |
| Writer | Nada bicara, panjang, urutan bagian | Kapan draf dianggap lulus |
| Reviewer (LLM) | Cara menilai nuansa | Aturan mana yang berlaku — itu dari `rulebook.js` |

Pemisahan ini disengaja: prompt mudah berubah dan sulit diaudit, sedangkan berkas aturan bisa dibaca siapa pun. Ketika keduanya bertentangan, aturan yang menang.

## 7. Nilai bisnis terukur

| Sebelum | Sesudah | Dampak |
|---|---|---|
| Menulis utas 4 post + naskah video: 45–70 menit | 1–3 menit (generate + baca jejak agent) | ~95% waktu penulisan |
| Pemeriksaan klaim: mengandalkan ingatan | 8 aturan diperiksa otomatis setiap draf | Klaim terlarang tertangkap sebelum terbit, bukan sesudah ditarik |
| Jejak keputusan: tidak ada | Jejak agent per draf, tidak bisa dihapus | Bisa dipertanggungjawabkan saat konten dipersoalkan |
| Jadwal: tebak-tebakan | Jam puncak audiens + cooldown 14 hari + jarak antar posting | Satu tayangan per jendela, tidak menumpuk di hari yang sama |

Pada uji 20 kasus, **20 lulus** setelah lima cacat rulebook diperbaiki. Sebelum perbaikan, 5 kasus gagal — semuanya karena aturan yang terlalu longgar atau terlalu ketat, bukan karena model. Rinciannya ada di `hasil-pengujian.html` dan `results.json`.

## 8. Di mana WorkBuddy memberi nilai tambah

- Seluruh aplikasi ini dibangun di dalam WorkBuddy: ekstraksi halaman produk, generator prompt video, sampai konversi CLI menjadi skill proyek (`affiliate-video`) yang bisa dipanggil ulang.
- Skill `affiliate-video` mem-port generator prompt video dari `app.js` ke Python dan **diverifikasi 96 dari 96 keluaran identik** terhadap implementasi aslinya — bukan ditulis ulang dari nol, tapi dibuktikan setara.
- Yang paling terasa: WorkBuddy memungkinkan pemeriksaan silang antara kode, data nyata, dan hasil di browser dalam satu alur kerja, sehingga cacat seperti "aturan format memeriksa draf lama" bisa ditemukan lewat pengujian, bukan lewat keluhan pengguna.

## 9. Yang belum selesai, dan kami sebutkan

- Auto-post masih simulasi; tidak ada integrasi API resmi Threads atau TikTok.
- Reviewer LLM bisa turun ke mode deterministik bila model gagal — dan itu dicatat di jejak agent.
- Uji 20 kasus menguji Reviewer, bukan seluruh pipeline Writer→Reviewer untuk setiap kasus.
- Dataset panitia belum diimpor; pengujian berjalan pada product sheet asli dari database studio.
