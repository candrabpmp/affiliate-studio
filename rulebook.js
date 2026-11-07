/* ============================================================
   RULEBOOK KONTEN AFILIASI — v1.0
   ------------------------------------------------------------
   Ini DOKUMEN, bukan kode. Setiap aturan punya ID yang dikutip
   oleh Reviewer saat menolak draf. Kalau aturan berubah, yang
   diubah file ini — bukan prompt, bukan teks di app.js.

   Kenapa dipisah: aturan yang tersembunyi di dalam prompt tidak
   bisa diaudit. Aturan yang jadi file bisa dibaca, di-diff, dan
   dipertanggungjawabkan.

   Cakupan: konten afiliasi Shopee untuk Threads dan TikTok.
   Rujukan hukum di bawah adalah penyederhanaan untuk keperluan
   demo, bukan nasihat hukum.
   ============================================================ */
window.RULEBOOK = {
  id: 'affiliate-claims',
  version: '1.0',
  updated: '2026-11-06',
  scope: 'Konten afiliasi Shopee · Threads (utas teks) dan TikTok (naskah video)',

  basis: [
    'UU 8/1999 Perlindungan Konsumen pasal 9–10 — larangan memberikan informasi menyesatkan dan klaim atas kualitas/kuantitas yang tidak benar.',
    'Ketentuan BPOM tentang klaim pada iklan obat, suplemen, dan pangan olahan — klaim penyembuhan hanya boleh untuk obat berizin edar.',
    'UU 33/2014 Jaminan Produk Halal — sebutan "halal" mengikuti sertifikasi, bukan penilaian sendiri.',
    'Ketentuan platform: batas panjang post Threads, batas caption TikTok, larangan hashtag di utas Threads.'
  ],

  /* ------------------------------------------------------------
     severity:
       block = draf tidak boleh lolos sebelum diperbaiki
       warn  = dicatat di transkrip, tidak menghalangi
     kind:
       regex     pola terlarang tanpa syarat
       gated     pola terlarang KECUALI sumber produk menyebutkannya
       tone      nada merek (frasa, kapital, emoji)
       numeric   angka & satuan harus ada di sumber
       format    batas platform
       disclosure pengungkapan afiliasi
     ------------------------------------------------------------ */
  rules: [
    {
      id: 'R-01',
      title: 'Akurasi fakta — angka dan spesifikasi harus ada di sumber',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'numeric',
      basis: 'UU 8/1999 pasal 9–10',
      explain: 'Setiap angka bersatuan (harga, kapasitas, ukuran, daya) harus bisa dilacak ke product sheet atau deskripsi seller. Angka yang tidak ada di sumber adalah karangan, sekalipun terdengar wajar.',
      fix: 'Hapus angkanya, atau ganti dengan angka yang benar-benar tertulis di sumber.'
    },

    {
      id: 'R-02',
      title: 'Klaim kesehatan dan penyembuhan dilarang',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'regex',
      basis: 'Ketentuan BPOM tentang klaim iklan',
      explain: 'Produk non-obat tidak boleh diklaim menyembuhkan, mengobati, atau meredakan penyakit. Ini aturan paling sering dilanggar di konten afiliasi, dan paling mahal akibatnya.',
      fix: 'Ganti ke manfaat yang bisa dilihat (nyaman dipakai, ringan dibawa) atau ke pengalaman pemakaian, bukan hasil medis.',
      /* negasi di depan kata ("bukan obat", "tanpa obat") tidak dihitung pelanggaran */
      negatable: true,
      patterns: [
        '\\b(sembuh|menyembuhkan|kesembuhan|sembuhkan|penyembuhan)\\b',
        '\\b(mengobati|diobati|obat)\\b',
        '\\b(ampuh|mujarab|manjur)\\b',
        '\\banti\\s*(kanker|kolesterol|diabetes|radang|bakteri)\\b',
        '\\b(detoks|detoksifikasi)\\b',
        '\\bmenurunkan\\s+(tekanan\\s+darah|gula\\s+darah|kolesterol|berat\\s+badan)\\b',
        '\\b(mengatasi|menghilangkan|meredakan)\\s+(penyakit|sakit|nyeri|maag|gatal|jerawat|dermatitis|batuk|flu)\\b',
        '\\b(terapi|pengobatan)\\b'
      ]
    },

    {
      id: 'R-03',
      title: 'Klaim halal hanya boleh jika sumber menyebut sertifikasi',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'gated',
      basis: 'UU 33/2014 Jaminan Produk Halal',
      explain: 'Kata "halal" adalah status sertifikasi, bukan penilaian penjual. Menyebut halal tanpa dasar di sumber adalah klaim yang tidak bisa dipertanggungjawabkan.',
      fix: 'Hapus kata halal, atau sebut apa adanya: "belum ada info sertifikasi halal".',
      patterns: ['\\bhalal(an|\\s+mui|\\s+thoyyiban)?\\b', '\\bsertifikat\\s+halal\\b']
    },

    {
      id: 'R-04',
      title: 'Klaim otoritas dan superlatif harus ada di sumber',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'gated',
      basis: 'UU 8/1999 pasal 10 — klaim kualitas tanpa dasar',
      explain: '"BPOM", "SNI", "original", "nomor 1", "terlaris", "termurah" adalah klaim yang bisa dituntut. Kalau sumber produk tidak menyebutkannya, konten tidak boleh mengklaimnya.',
      fix: 'Hapus klaimnya. Kalau sumber menyebut, kutip apa adanya beserta konteksnya.',
      patterns: [
        '\\b(bpom|sni|iso\\s*\\d+|halal\\s+mui)\\b',
        '\\b(original|ori|asli|kw\\s*super)\\b',
        '\\b(nomor\\s*1|no\\.?\\s*1|terlaris|terbaik|termurah|tercepat)\\b',
        '\\bpaling\\s+(bagus|baik|murah|kuat|awet|enak|ringan|mahal|cepat|cantik|keren|recommended)\\b'
      ]
    },

    {
      id: 'R-05',
      title: 'Janji dan jaminan hasil tidak boleh dikarang',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'gated',
      basis: 'UU 8/1999 pasal 9–10',
      explain: '"Dijamin", "pasti", "100% berhasil", "sudah terbukti" adalah janji. Kalau bukan syarat resmi dari penjual, itu janji yang dibuat sendiri oleh afiliator.',
      fix: 'Turunkan jadi pengalaman pribadi yang jujur, atau kutip syarat garansi persis seperti di sumber.',
      patterns: [
        '\\b(dijamin|jaminan|garansi|terbukti)\\b',
        '100\\s?%',
        '\\bpasti\\s+\\w+\\b'
      ]
    },

    {
      id: 'R-06',
      title: 'Nada merek — frasa klise, kapital berlebih, emoji berlebihan',
      severity: 'warn',
      applies: ['threads', 'tiktok'],
      kind: 'tone',
      basis: 'Panduan nada merek studio',
      explain: 'Bahasa iklan yang klise membuat konten terbaca sebagai iklan, bukan rekomendasi. Kapital berlebih dan emoji bertumpuk menurunkan kepercayaan.',
      fix: 'Tulis ulang dengan kalimat sendiri; maksimal 2 emoji per utas, kapital hanya di awal kalimat.',
      phrases: [
        'Racun Shopee', 'Wajib checkout', 'Sumpah bagus banget', 'Dalam dunia yang serba cepat',
        'Tak dapat dipungkiri', 'Kesimpulannya', 'Mari kita bahas', 'Jangan sampai kehabisan',
        'Bestie', 'Bun'
      ],
      maxEmoji: 2,
      maxCapsRatio: 0.35
    },

    {
      id: 'R-07',
      title: 'Batas format platform',
      severity: 'block',
      applies: ['threads', 'tiktok'],
      kind: 'format',
      basis: 'Ketentuan Threads dan TikTok',
      explain: 'Batas teknis platform. Melanggarnya membuat konten gagal terbit atau terpotong.',
      fix: 'Sesuaikan panjang dan struktur sampai masuk batas.',
      params: {
        threads: { postsMin: 3, postsMax: 5, charsMin: 250, charsMax: 500, hashtag: false, linkInLastPostOnly: true },
        tiktok: { hookRequired: true, scenesMin: 3, captionMax: 2200 }
      }
    },

    {
      id: 'R-08',
      title: 'Pengungkapan afiliasi harus ada',
      severity: 'warn',
      applies: ['threads', 'tiktok'],
      kind: 'disclosure',
      basis: 'Praktik iklan yang jujur',
      explain: 'Pembaca berhak tahu bahwa penulis mendapat komisi. Tanpa pengungkapan, rekomendasi terbaca sebagai pendapat netral.',
      fix: 'Tambahkan penanda sederhana: "link afiliasi" di post terakhir, atau "link di bio · afiliasi" di caption.',
      /* "afiliasinya" juga harus kena — batas kata di belakang terlalu ketat */
      patterns: ['\\bafiliasi\\w*', '\\blink\\s+di\\s+bio\\b', '\\bkomisi\\b', '\\b#ad\\b']
    }
  ],

  /* larangan mutlak: kalau ini muncul, draf berhenti tanpa negosiasi */
  hardStop: ['R-02', 'R-03']
};

if (typeof module !== 'undefined' && module.exports) module.exports = window.RULEBOOK;
