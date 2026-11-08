/* =========================================================================
   PENGATURAN TERSIMPAN
   -------------------------------------------------------------------------
   File ini dibaca otomatis saat aplikasi dibuka, sebagai nilai awal ketika
   database (data/affiliate.db) masih kosong. Kalau database sudah punya
   pengaturan, versi database yang dipakai — file ini tidak menimpanya.

   Cara mengisi:
     1. Buka halaman Pengaturan di aplikasi.
     2. Atur semuanya seperti biasa.
     3. Klik "Export pengaturan (JSON)".
     4. Timpa file ini (pengaturan.js) dengan hasil unduhannya, lalu refresh.

   savedAt = null  → file ini hanya dipakai kalau browser belum punya
                     pengaturan sama sekali (tidak menimpa setelan yang ada).
   savedAt = angka → file ini dianggap hasil ekspor dan otomatis menimpa
                     pengaturan lama saat refresh.

   CATATAN: API key ikut tersimpan di file ini kalau kamu mengekspor saat key
   sedang terisi. Jangan bagikan / commit file ini ke repo publik.
   ========================================================================= */
window.SAVED_SETTINGS = {
  savedAt: null,
  settings: {
    mode: 'simulasi',
    failRate: 20,
    maxAttempts: 3,
    retryDelay: 2,
    hourThreads: 12,
    hourTiktok: 19,
    gapMin: 45
  },
  ai: {
    threads: {
      on: false,
      provider: 'custom',
      model: 'ag/gemini-3.8-flash-low',
      // Jangan isi API key di sini kalau repo ini publik. Isi lewat halaman
      // Pengaturan — key tersimpan di data/affiliate.db yang di-gitignore.
      // Base URL dikosongkan: aplikasi ini dipakai publik, jadi nilai awal tidak
      // boleh menunjuk ke gateway lokal pemilik. Pengunjung mengisi sendiri
      // lewat popup (tersimpan di localStorage browser masing-masing).
      key: '',
      baseUrl: '',
      temp: 0.9
    },
    tiktok: {
      on: false,
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      key: '',
      baseUrl: '',
      temp: 0.9
    }
  },
  copy: {}
};
