# Lembar Akuntabilitas — Affiliate Studio

**Tantangan C · Agen Kreator · AI CAN DO IT, Tencent Cloud Hackathon Indonesia 2026**

Satu halaman. Empat kolom: apa yang boleh dilihat, apa yang berjalan sendiri, apa yang harus disetujui manusia, dan apa yang tidak akan pernah dilakukan.

---

## 1. Yang dapat diakses agent

| Sumber | Isi | Batas |
|---|---|---|
| Product sheet per produk | Nama, harga, jumlah terjual, toko, komisi, spesifikasi, deskripsi seller, varian, ongkir | Hanya produk yang diimpor ke studio ini |
| **Rulebook** (`rulebook.js`) | 8 aturan bernomor beserta dasar hukum dan cara perbaikannya | Boleh dibaca agent, **hanya manusia yang boleh mengubahnya** |
| Konfigurasi LLM | Provider, model, suhu | Kunci API disimpan lokal, tidak pernah dikirim ke agent mana pun |
| Riwayat revisi & jejak agent | Draf lama, transkrip antar-agent, putusan Reviewer | Hanya-baca bagi agent |

Agent **tidak** punya akses ke akun Shopee, akun Threads, akun TikTok, kredensial pembayaran, data pembeli, atau berkas di luar folder studio.

## 2. Yang dijalankan otonom (tanpa bertanya)

- Menyusun **brief** dari product sheet (Planner).
- **Menulis draf** Threads dan TikTok dari brief tersebut (Writer).
- **Menilai draf sendiri** terhadap rulebook dan menolaknya (Reviewer).
- **Mengulang** penulisan sampai 3 iterasi bila ditolak.
- **Memilih slot jadwal** yang belum terpakai, menghormati jam puncak audiens, cooldown 14 hari per produk, dan jarak antar posting.
- Menulis **log audit** untuk setiap langkah di atas.

Semua ini menghasilkan *usulan*, bukan terbitan. Tidak ada satu pun yang mengubah dunia luar.

## 3. Yang memerlukan persetujuan manusia

| Tindakan | Gerbang |
|---|---|
| Konten dianggap layak tayang | Tombol **Lolos** — hanya manusia yang bisa menekan |
| Konten yang **ditolak Reviewer** tetap disetujui | Hanya lewat **override** yang mewajibkan alasan tertulis; alasan tersimpan di jejak agent dan tidak bisa dihapus |
| Video TikTok dianggap siap | Berkas video harus benar-benar ada; tidak ada jalur "lolos" tanpa berkas |
| Posting benar-benar dijalankan | Mode `manual`: aplikasi membuka modal, manusia yang menekan tombol platform |
| Mengubah aturan | `rulebook.js` adalah berkas yang diedit manusia, bukan sesuatu yang bisa ditulis agent |
| Menghapus riwayat | Dihapus hanya oleh tindakan eksplisit manusia |

## 4. Yang tidak akan pernah dilakukan agent

- **Menerbitkan** ke Threads atau TikTok tanpa persetujuan manusia.
- **Menghapus** riwayat revisi atau jejak audit untuk "merapikan" hasil.
- **Mengarang fakta**: setiap angka wajib bisa dilacak ke product sheet (R-01).
- **Mengklaim khasiat kesehatan** dalam bentuk apa pun (R-02) — aturan ini tidak punya jalur override otomatis.
- **Mengklaim halal, BPOM, SNI, atau "nomor 1"** yang tidak disebut sumber (R-03, R-04).
- **Melanjutkan perulangan tanpa batas**: berhenti di iterasi ke-3 dan menyerahkan sisanya ke manusia.
- **Menilai dirinya sendiri lulus.** Writer tidak pernah melihat kata "lulus" — hanya daftar pelanggaran. Yang memutuskan adalah Reviewer, dan Reviewer tidak menulis.

---

## Batasan yang kami akui terbuka

1. **Auto-post masih simulasi.** Tidak ada panggilan ke API resmi Threads atau TikTok. Mode `simulasi` melempar dadu untuk mensimulasikan kegagalan jaringan; mode `manual` menyerahkan penekanan tombol ke manusia. Kami tidak menyebut ini integrasi.
2. **Reviewer LLM bisa tidak tersedia.** Bila model gagal, penilaian turun ke mesin aturan deterministik dan jejak agent **mencatatnya secara eksplisit** (`degraded`). Kami tidak menyembunyikan penurunan mutu.
3. **R-01 adalah heuristik.** Pencocokan angka bisa salah pada rentang ("8–12 jam"). Karena itu setiap pelanggaran menyertakan buktinya, supaya manusia bisa menilai dan menolak putusan mesin.
4. **Aturan tidak lengkap.** Delapan aturan bukan cakupan penuh iklan Indonesia. Rulebook sengaja dibuat sebagai berkas terpisah supaya bisa ditambah tanpa menyentuh kode.
5. **Uji 20 kasus menguji Reviewer, bukan seluruh pipeline.** Kasus berjalan terhadap fungsi penilai yang sesungguhnya, tetapi tidak setiap kasus melalui Writer LLM. Kami menyebutnya apa adanya di laporan hasil.

*Dokumen ini adalah pernyataan desain, bukan jaminan hukum. Rujukan peraturan di dalamnya adalah penyederhanaan untuk keperluan hackathon.*
