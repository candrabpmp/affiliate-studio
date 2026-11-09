/* =========================================================
   Affiliate Studio — Shopee Content Ops
   Workflow: generate -> review -> jadwal posting (+ retry)
   ========================================================= */

/* ---------------- utils ---------------- */
/* penanda build UI — ditampilkan di sidebar supaya gampang memastikan browser
   benar-benar memuat app.js terbaru, bukan cache lama. */
const UI_BUILD = '2026-11-06d';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const rupiah = (n) => 'Rp' + (Number(n) || 0).toLocaleString('id-ID');
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/* Ambil varian yang belum terpakai untuk kategori+slot yang sama,
   supaya dua produk sekategori tidak dapat kalimat pembuka identik. */
const _usedLines = new Map();
function usedDump() {
  const o = {};
  _usedLines.forEach((set, k) => { if (set.size) o[k] = Array.from(set); });
  return o;
}
function usedLoad(obj) {
  _usedLines.clear();
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach((k) => {
    const arr = Array.isArray(obj[k]) ? obj[k].filter((n) => typeof n === 'number') : [];
    if (arr.length) _usedLines.set(k, new Set(arr));
  });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/* ---------------- zona waktu audiens ----------------
   Jadwal dihitung di jam AUDIENS, bukan jam perangkat. Semua konversi lewat
   Intl.DateTimeFormat supaya perubahan offset (WIB/WITA/WIT, atau DST di zona
   lain) ikut terurus — jangan pernah menambah 7 jam secara hardcode. */
const TZ_LIST = [
  { id: 'Asia/Jakarta', label: 'WIB', full: 'WIB · Jakarta (UTC+7)' },
  { id: 'Asia/Makassar', label: 'WITA', full: 'WITA · Makassar (UTC+8)' },
  { id: 'Asia/Jayapura', label: 'WIT', full: 'WIT · Jayapura (UTC+9)' },
  { id: 'Asia/Singapore', label: 'SGT', full: 'SGT · Singapura (UTC+8)' },
  { id: 'browser', label: 'perangkat', full: 'Ikut jam perangkat ini' }
];
const WD_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* zona yang benar-benar dipakai (IANA), sudah mempertimbangkan pilihan "perangkat" */
function tzId() {
  const t = S.settings.tzAudience;
  if (!t || t === 'browser') {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta'; }
    catch (e) { return 'Asia/Jakarta'; }
  }
  return t;
}
function tzLabel() {
  const t = S.settings.tzAudience || 'Asia/Jakarta';
  const f = TZ_LIST.find((x) => x.id === t);
  if (f) return f.label;
  return tzId().split('/').pop().replace(/_/g, ' ') || 'lokal';
}

/* label pendek untuk zona perangkat — dipakai sebagai pembanding di Pengaturan */
function deviceTzLabel() {
  try {
    const id = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const f = TZ_LIST.find((x) => x.id === id);
    return f ? f.label : (id.split('/').pop().replace(/_/g, ' ') || 'lokal');
  } catch (e) { return 'lokal'; }
}

/* pecahan tanggal/jam dari satu instant, dilihat di zona tertentu */
function tzParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || tzId(), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  dtf.formatToParts(new Date(ts)).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return {
    y: +p.year, m: +p.month, d: +p.day,
    h: +p.hour % 24, mi: +p.minute, s: +p.second,
    wd: Math.max(0, WD_KEYS.indexOf(p.weekday))
  };
}

/* selisih zona terhadap UTC (ms) pada instant tertentu */
function tzOffset(ts, tz) {
  const p = tzParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ts;
}

/* jam dinding di zona -> instant. Dua lintasan supaya offset yang berubah
   (DST) tetap benar; satu lintasan bisa meleset satu jam di hari pergantian. */
function zonedToUtc(y, m, d, h, mi, tz) {
  const naive = Date.UTC(y, m - 1, d, h, mi, 0);
  let ts = naive - tzOffset(naive, tz || tzId());
  ts = naive - tzOffset(ts, tz || tzId());
  return ts;
}

/* kunci tanggal di kalender audiens — dipakai untuk hitungan "per hari" */
function tzDayKey(ts) {
  const p = tzParts(ts);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/* input datetime-local selalu menampilkan jam AUDIENS, bukan jam perangkat */
function toAudienceInput(ts) {
  if (!ts) return '';
  const p = tzParts(ts);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
function fromAudienceInput(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

/* waktu jadwal ditampilkan di jam audiens, bukan jam perangkat */
function fmtSched(ts) {
  if (!ts) return '—';
  const p = tzParts(ts);
  return `${pad(p.d)}/${pad(p.m)} ${pad(p.h)}:${pad(p.mi)}`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; el.style.transition = 'all .2s'; }, 2000);
  setTimeout(() => el.remove(), 2300);
}

function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(() => toast('Disalin ke clipboard', 'ok')).catch(() => fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Disalin ke clipboard', 'ok'); } catch (e) { toast('Gagal menyalin', 'err'); }
  ta.remove();
}

/* ---------------- kategori & knowledge base copywriting ---------------- */
const CATS = {
  safety: {
    label: 'Sepatu Safety', icon: '🥾',
    pains: [
      'Sepatu kerja murah biasanya baru seminggu solnya udah mulai ngelupas.',
      'Kerja di lokasi seharian bikin kaki pegal kalau solnya nggak bener.',
      'Lantai basah + sol licin itu kombinasi yang bikin deg-degan.'
    ],
    features: ['ujung besi (steel toe)', 'sol karet tebal', 'bisa COD / bayar di tempat'],
    hooks: [
      'Sepatu safety {{price}}? Aku juga sempat ragu.',
      'Buat yang tiap hari masuk proyek, ini sayang kalau di-skip.',
      'Harga segini buat sepatu safety, jangan kaget dulu.'
    ],
    visuals: [
      'Close-up sol sepatu diinjak di genangan air, air nggak nyerap',
      'Tangan ketuk bagian ujung besi sepatu, bunyi "teng"',
      'Orang pakai sepatu jalan di area proyek / paving'
    ],
    tags: ['sepatusafety', 'sepatuproyek', 'sepatukerja', 'bootsafety'],
    problems: [
      'Sepatu proyek paling sering diganti bukan karena jebol, tapi karena solnya udah rata dan kaki udah telanjur pegal.',
      'Kerja di lokasi itu bukan soal gaya. Tapi tiap pulang, yang pertama dicopot ya sepatunya.',
      'Yang bikin kapok beli sepatu safety murah: baru seminggu, jahitannya udah mulai nganga.'
    ],
    honest: [
      'Jujur dulu: bahannya sintetis, bukan kulit asli. Jadi jangan bayangin langsung lentur di hari pertama, butuh beberapa hari adaptasi.',
      'Ujung besinya ada, tapi ini bukan sepatu safety bersertifikat. Kalau proyekmu wajib SNI, tanya dulu ke tokonya sebelum beli.',
      'Ini sepatu kerja, bukan sepatu buat gaya. Modelnya ya gitu-gitu aja, dan itu justru masuk akal di harganya.'
    ],
    reality: [
      'Realitanya dipakai 8 sampai 10 jam: berdiri di beton, naik turun tangga, kena genangan. Yang bikin betah bukan ujung besinya, tapi sol yang nggak bikin telapak panas.',
      'Masalah klasik sepatu kerja: ditaruh di depan pintu, dipakai lagi besok tanpa dijemur. Kalau bahannya nggak breathable, baunya yang lebih dulu pensiun.'
    ],
    psych: [
      'Anehnya, orang rela beli sneakers 1 juta buat nongkrong, tapi buat kerja 10 jam sehari mikir dua kali kalau di atas 100rb.',
      'Padahal yang bikin kaki rusak bukan gaya hidup, tapi 8 jam berdiri di permukaan keras, tiap hari, bertahun-tahun.'
    ],
    pivot: [
      'Tapi dibanding sepatu proyek lama yang solnya udah rata, yang ini jelas lebih aman. Bukan karena hebat, tapi karena fungsinya masih utuh.',
      'Kalau dihitung, {{price}} buat 6 sampai 8 bulan itu jauh lebih murah daripada sekali kaki keseleo di lokasi.'
    ],
    questions: [
      'Kamu tim sepatu kerja mahal sekali beli, atau murah tapi ganti tiap semester?',
      'Sepatu kerja kamu sekarang udah berapa lama dipakai? Jujur aja.',
      'Menurut kamu, sepatu kerja itu boleh murah atau harus mahal?'
    ]
  },
  sneakers: {
    label: 'Sneakers', icon: '👟',
    pains: [
      'Sneakers murah biasanya solnya keras, dipakai jalan 10 menit udah pegal.',
      'Beli sepatu online sering zonk: foto bagus, bahan tipis.',
      'Butuh sepatu yang bisa buat kerja sekaligus nongkrong?'
    ],
    features: ['sol empuk & ringan', 'model casual buat harian', 'bahan adem'],
    hooks: [
      'Sneakers {{price}}, dan ini yang nggak kelihatan murahan.',
      'Nyari sneakers di bawah 100rb yang nggak bikin kaki pegal itu susah.',
      'Sepatu {{price}} yang aku pakai buat jalan seharian.'
    ],
    visuals: [
      'Orang jalan santai di trotoar, kamera ngikutin kaki',
      'Close-up sol ditekan jempol, kelihatan empuk',
      'OOTD kaki: sneakers dipadukan celana pendek & kaos'
    ],
    tags: ['sneakers', 'sepatupria', 'sepatumurah', 'sneakerspria'],
    problems: [
      'Sneakers murah biasanya kelihatan oke di foto, tapi begitu dipakai jalan 20 menit, telapak udah protes.',
      'Masalahnya bukan harga. Masalahnya kita sering beli sepatu buat gaya, padahal yang dibutuhin buat jalan.',
      'Sepatu harian itu yang paling sering dipakai, tapi paling jarang dipikirin.'
    ],
    honest: [
      'Jujur: ini bukan sepatu lari beneran. Nggak ada foam responsif, nggak ada carbon plate. Ini sepatu kasual yang kebetulan nyaman buat jalan.',
      'Solnya empuk, tapi empuk bukan berarti tahan lama. Kalau dipakai lari 10K tiap hari, jangan harap awet setahun.',
      'Warna aslinya bisa sedikit lebih gelap dari foto, biasanya karena pencahayaan studio. Cek ulasan yang ada fotonya dulu.'
    ],
    reality: [
      'Realitanya dipakai buat jalan ke warung, naik motor, nongkrong, kadang buat kerja. Bukan buat maraton.',
      'Dan seperti kebanyakan sepatu, dia bakal lebih sering ditaruh di rak daripada dirawat.'
    ],
    psych: [
      'Kenapa orang tetap cari sneakers murah? Karena otak kita nggak ngitung harga per pemakaian, kita cuma lihat angka di layar.',
      'Ada rasa aman sendiri waktu punya sepatu "buat jaga-jaga" di rak. Padahal yang dipakai ya itu-itu aja.'
    ],
    pivot: [
      'Tapi buat fungsi harian, ini lebih masuk akal daripada sepatu 700rb yang ujungnya juga dipakai ke warung.',
      'Selama ekspektasinya sepatu kasual, bukan sepatu lari, ini nggak bikin nyesel.'
    ],
    questions: [
      'Kamu kalau beli sepatu, lihat model dulu atau nyaman dulu?',
      'Berapa harga sepatu paling mahal yang pernah kamu beli, dan masih dipakai sampai sekarang?',
      'Sepatu yang paling sering kamu pakai itu harganya berapa?'
    ]
  },
  sandal: {
    label: 'Sandal', icon: '🩴',
    pains: [
      'Sandal murah biasanya licin kalau kena air.',
      'Sandal jepit buat ke warung kok malah bikin kapalan.',
      'Sandal yang empuk tapi nggak kelihatan murahan itu susah dicari.'
    ],
    features: ['bahan jelly empuk', 'ringan & gampang dibawa', 'sol berpola anti selip'],
    hooks: [
      'Sandal {{price}} yang empuknya nggak murahan.',
      'Sendal buat harian, tapi nyaman buat jalan jauh.',
      'Ini sandal yang akhirnya aku beli setelah 5 kali salah beli.'
    ],
    visuals: [
      'Sandal dipakai jalan di lantai basah, kaki nggak selip',
      'Tangan menekan bantalan sandal, kembali ke bentuk semula',
      'Sandal dijejer bareng outfit kasual'
    ],
    tags: ['sandalpria', 'sandals', 'sandalwanita', 'sandalmurah'],
    problems: [
      'Sandal jepit murah biasanya licin kalau kena air. Dan itu baru kerasa setelah sekali kepleset di kamar mandi.',
      'Sandal buat ke warung kok malah bikin kapalan. Kadang bukan salah kaki, salah bantalannya.',
      'Yang paling sering beli sandal itu orang yang sandalnya sering putus, bukan yang butuh sandal bagus.'
    ],
    honest: [
      'Bahannya EVA, jadi ringan dan gampang dicuci. Tapi EVA juga gampang kempes kalau kena panas mesin cuci.',
      'Ini sandal rumahan, bukan sandal gunung. Jangan harap nge-grip di jalur licin atau tanah miring.',
      'Modelnya simpel banget. Kalau kamu cari yang kelihatan mahal, ini bukan jawabannya.'
    ],
    reality: [
      'Realitanya dipakai ke kamar mandi, ke warung, kadang ke teras. Basah, diinjak, ditinggal.',
      'Dan seperti sandal pada umumnya: dipakai sampai ada yang putus, baru beli lagi.'
    ],
    psych: [
      'Kenapa orang beli lima sandal sekaligus? Bukan karena butuh, tapi karena takut kehabisan yang nyaman.',
      'Sandal itu barang paling murah yang paling sering bikin kesal kalau salah beli.'
    ],
    pivot: [
      'Dibanding sandal jepit 15rb yang licin, naik ke {{price}} buat bantalan yang lebih tebal itu hitungannya murah.',
      'Bukan sandal terbaik. Tapi buat dipakai tiap hari di rumah, ini udah cukup.'
    ],
    questions: [
      'Sandal rumah kamu biasanya bertahan berapa bulan sebelum putus?',
      'Kamu tim sandal jepit atau sandal selop?',
      'Pernah kepleset gara-gara sandal licin? Di mana kejadiannya?'
    ]
  },
  hoodie: {
    label: 'Hoodie / Sweater', icon: '🧥',
    pains: [
      'Hoodie murah biasanya bahannya tipis dan gerah.',
      'Beli hoodie online, sampai rumah ternyata nggak sesuai foto.',
      'Butuh jaket yang hangat tapi nggak bikin gerah di motor?'
    ],
    features: ['bahan fleece tebal', 'hangat tapi nggak gerah', 'unisex pria & wanita'],
    hooks: [
      'Hoodie {{price}} + bonus topi. Serius.',
      'Bahan fleece, tebal, tapi nggak bikin gerah.',
      'Ini hoodie yang bikin temen nanya "beli di mana?"'
    ],
    visuals: [
      'Close-up kain fleece ditarik, kelihatan tebal',
      'Orang pakai hoodie naik motor malam, tangan nggak dingin',
      'Twirl / putar badan nunjukin jatuhnya hoodie'
    ],
    tags: ['hoodie', 'sweater', 'jaketpria', 'hoodiefleece'],
    problems: [
      'Hoodie murah biasanya bahannya tipis dan gerah. Dipakai naik motor kedinginan, dipakai di ruangan kegerahan.',
      'Beli hoodie online itu judi: foto tebal, sampai rumah tipis banget.',
      'Yang bikin hoodie nggak pernah dipakai: bahannya panas, tapi nggak bisa nahan angin.'
    ],
    honest: [
      'Bahannya katun fleece, tebalnya di tengah. Bukan yang paling tebal, bukan yang paling tipis. Jangan bayangin hoodie musim dingin.',
      'Bonus topinya beneran ada, tapi desainnya random. Jangan berharap warnanya nyambung sama hoodienya.',
      'Ukuran jumbo tersedia, tapi potongannya boxy. Kalau kamu suka fit badan, turun satu size.'
    ],
    reality: [
      'Realitanya dipakai malam waktu naik motor, atau di ruangan ber-AC yang kadang kelewat dingin.',
      'Dan hoodie itu jenis baju yang paling sering dicuci bareng, karena dipakai terus-terusan.'
    ],
    psych: [
      'Hoodie itu satu-satunya pakaian yang bikin orang merasa aman tanpa harus mikir gaya.',
      'Kita beli hoodie bukan karena butuh hangat, tapi karena males mikir mau pakai apa pagi ini.'
    ],
    pivot: [
      'Buat harganya, ini jauh lebih masuk akal daripada hoodie brand yang ujungnya juga dipakai tidur.',
      'Kalau kamu butuh satu jaket yang bisa dipakai motoran sekaligus nongkrong, ini udah nutup dua-duanya.'
    ],
    questions: [
      'Hoodie kamu sekarang udah berapa tahun? Masih dipakai atau cuma numpuk di lemari?',
      'Kamu tim hoodie tebal atau hoodie tipis buat sehari-hari?',
      'Berapa hoodie yang kamu punya tapi nggak pernah dipakai?'
    ]
  },
  jeans: {
    label: 'Celana Jeans', icon: '👖',
    pains: [
      'Jeans cutbray murah biasanya bahannya kaku, nggak bisa ditekuk.',
      'Highwaist yang beneran pas di badan itu susah dicari.',
      'Jeans stretch yang nggak melar setelah dicuci? Langka.'
    ],
    features: ['bahan stretch, nyaman dipakai', 'potongan highwaist', 'model cutbray'],
    hooks: [
      'Jeans cutbray {{price}} yang bahannya stretch.',
      'Highwaist + cutbray, harga {{price}}.',
      'Celana yang bikin kaki kelihatan lebih jenjang, segini harganya.'
    ],
    visuals: [
      'Close-up kain jeans ditarik ke samping, kelihatan stretch',
      'Orang pakai jeans jalan ke arah kamera, framing dari bawah',
      'Before/after pakai jeans highwaist vs celana biasa'
    ],
    tags: ['jeanswanita', 'cutbray', 'jeanshighwaist', 'celanajeans'],
    problems: [
      'Jeans cutbray murah biasanya bahannya kaku. Duduk aja susah, apalagi naik motor.',
      'Highwaist yang beneran pas di badan itu susah dicari. Kebanyakan longgar di pinggang, ketat di paha.',
      'Masalah jeans murah bukan di modelnya, tapi di bahannya yang melar setelah dua kali cuci.'
    ],
    honest: [
      'Bahannya denim stretch. Enak dipakai, tapi ada batasnya. Jangan dipaksa muat kalau size-nya udah mepet.',
      'Cutbray bikin kaki kelihatan lebih panjang, tapi juga bikin sepatu kelihatan lebih besar. Itu trade-off-nya.',
      'Warna bisa sedikit beda dari foto, terutama denim. Cuci pertama sebaiknya dipisah dari baju putih.'
    ],
    reality: [
      'Realitanya dipakai buat kerja, kuliah, nongkrong. Kadang tiga-tiganya dalam sehari.',
      'Dan jeans itu jarang dicuci. Jadi kenyamanan di hari kelima lebih penting daripada penampilan di hari pertama.'
    ],
    psych: [
      'Jeans itu satu-satunya pakaian yang kita pakai buat merasa rapi tanpa harus pakai celana bahan.',
      'Kenapa orang punya empat jeans? Karena satu-satunya yang pas biasanya lagi dicuci.'
    ],
    pivot: [
      'Dibanding jeans kaku yang bikin nggak betah duduk, stretch itu bukan kemewahan, itu kebutuhan.',
      'Buat harganya, ini lebih masuk akal daripada jeans 400rb yang sama-sama melar setelah setahun.'
    ],
    questions: [
      'Kamu lebih milih jeans yang nyaman atau yang bikin kelihatan jenjang?',
      'Jeans paling lama yang pernah kamu punya bertahan berapa tahun?',
      'Kamu tim jeans highwaist atau low waist?'
    ]
  },
  tumbler: {
    label: 'Tumbler', icon: '🥤',
    pains: [
      'Tumbler murah biasanya bocor di dalam tas.',
      'Es batu udah leleh sebelum sampai kantor?',
      'Tumbler kecil bikin bolak-balik isi ulang.'
    ],
    features: ['stainless steel', 'tahan panas & dingin', 'kapasitas 900ml'],
    hooks: [
      'Tumbler 900ml {{price}}. Air es tahan seharian.',
      'Ini tumbler yang bikin aku berhenti beli es teh tiap hari.',
      'Tumbler {{price}} yang nggak bocor di tas.'
    ],
    visuals: [
      'Tumbler dibalik, nggak ada air netes',
      'Es batu dituang, tutup, 6 jam kemudian masih ada es',
      'Tumbler dimasukin ke tas ransel, muat'
    ],
    tags: ['tumbler', 'tumblerstainless', 'botolminum', 'tumblermurah'],
    problems: [
      'Tumbler murah biasanya bocor di tas. Dan kamu baru sadar setelah buku atau laptop udah basah.',
      'Es batu udah leleh sebelum sampai kantor. Ujung-ujungnya beli es teh lagi, dan tumbler-nya nganggur.',
      'Masalah tumbler bukan di kapasitasnya, tapi di tutupnya. Tutup yang nggak presisi itu yang bikin males dipakai.'
    ],
    honest: [
      'Ini stainless steel, tapi bukan vacuum double-wall kelas premium. Klaim tahan 8 jam itu dari toko, realitanya tergantung isi dan suhu ruangan.',
      'Warna tutupnya dikirim random. Kalau kamu orang yang butuh serba matching, ini bakal sedikit mengganggu.',
      '900ml itu besar. Muat di tas ransel, tapi belum tentu muat di holder motor kecil.'
    ],
    reality: [
      'Realitanya dipakai di meja kerja, dibawa meeting, ditinggal di mobil. Yang bikin betah bukan kapasitasnya, tapi karena nggak perlu bolak-balik isi ulang.',
      'Dan seperti kebanyakan tumbler: minggu pertama rajin dicuci, bulan kedua cuma dibilas.'
    ],
    psych: [
      'Beli tumbler itu bukan soal hemat. Itu soal merasa jadi orang yang punya rencana.',
      'Kita beli tumbler karena pengen berhenti jajan, bukan karena beneran berhenti jajan.'
    ],
    pivot: [
      'Tapi dibanding beli es teh 10rb tiap hari, satu tumbler ini balik modal dalam seminggu, kalau beneran dipakai.',
      'Bukan tumbler terbaik di pasaran. Tapi buat harga segini, fungsinya udah 90 persen sama.'
    ],
    questions: [
      'Tumbler kamu sekarang nganggur di lemari, atau beneran dipakai tiap hari?',
      'Kamu tim beli es teh terus, atau bawa minum dari rumah?',
      'Berapa tumbler yang udah kamu beli dan sekarang hilang?'
    ]
  },
  case: {
    label: 'Case / Aksesori', icon: '🎧',
    pains: [
      'Case AirPods murah gampang menguning dan longgar.',
      'Case yang nutupin lampu indikator bikin bingung sendiri.',
      'Case tebal bikin nggak muat di saku.'
    ],
    features: ['pas untuk AirPods Gen 1–4 & Pro', 'bahan nggak gampang kuning', 'buka-tutup nyaman'],
    hooks: [
      'Case AirPods {{price}}, dan ini yang paling worth.',
      'Case murah yang nggak bikin AirPods lecet.',
      'AirPods kamu masih telanjang? Ini solusinya.'
    ],
    visuals: [
      'Close-up case dipasang, bunyi klik pas',
      'Case dijatuhkan dari meja, AirPods aman',
      'Case dibuka-tutup satu tangan'
    ],
    tags: ['caseairpods', 'airpods', 'aksesorishp', 'casehp'],
    problems: [
      'Case AirPods murah gampang menguning. Dan begitu kuning, kelihatan jauh lebih tua dari umur aslinya.',
      'Case yang longgar bikin AirPods gampang jatuh. Yang terlalu tebal bikin nggak muat di saku.',
      'Yang paling sering kejadian: case-nya masih bagus, AirPods-nya udah ilang duluan.'
    ],
    honest: [
      'Bahannya silikon TPU, jadi empuk dan nggak licin. Tapi silikon bening tetap bisa kuning kalau kena matahari terus.',
      'Ini case, bukan pelindung anti air. Jangan harap bisa nyelam atau kena hujan deras.',
      'Cocok untuk Gen 1 sampai Pro 2, tapi bukan berarti semua muat sempurna. Cek tipe AirPods kamu dulu.'
    ],
    reality: [
      'Realitanya case ini lebih sering kena kunci, koin, dan dasar tas daripada kena jatuh beneran.',
      'Dan seperti aksesori kecil lainnya: dibeli karena lucu, dilupakan setelah seminggu.'
    ],
    psych: [
      'Kenapa orang beli case 13rb buat barang 2 juta? Karena rasanya aneh kalau barang mahal dibiarkan telanjang.',
      'Case itu bukan pelindung. Itu cara kita bilang "ini barang mahal" tanpa harus ngomong.'
    ],
    pivot: [
      'Dibanding case 80rb di toko aksesori, fungsinya sama: melindungi dari baret. Bedanya cuma di logo.',
      'Kalau AirPods kamu masih telanjang, ini cara termurah buat berhenti deg-degan tiap kali jatuh.'
    ],
    questions: [
      'AirPods kamu pakai case atau dibiarkan telanjang?',
      'Kamu pernah kehilangan case-nya, atau AirPods-nya sekalian?',
      'Case paling mahal yang pernah kamu beli buat HP, harganya berapa?'
    ]
  },
  tas: {
    label: 'Tas', icon: '🎒',
    pains: [
      'Tas murah biasanya jebol di jahitan tali, bukan di badannya.',
      'Resleting macet di tengah jalan itu bikin panik, apalagi kalau lagi buru-buru.',
      'Tali tipis yang nyayat bahu — baru kerasa setelah 20 menit dipakai.'
    ],
    features: ['bahan anti air', 'kompartemen laptop', 'tali bahu empuk'],
    hooks: [
      'Tas {{price}} yang muat laptop, jaket, dan botol sekaligus.',
      'Tas murah biasanya jebol di tali. Yang ini nggak.',
      'Buat yang tiap hari bawa barang kayak pindahan.'
    ],
    visuals: [
      'Tas diisi laptop 14 inci, ditutup, resleting masih jalan halus',
      'Air dituang ke permukaan tas, menggulir tanpa nyerap',
      'Tas digantung satu tangan lalu diayun, jahitan tali tetap rapi'
    ],
    tags: ['tas', 'tasransel', 'taslaptop', 'backpackmurah'],
    problems: [
      'Tas murah biasanya jebol di jahitan tali, bukan di badannya. Dan itu baru ketahuan waktu lagi jauh dari rumah.',
      'Resleting yang macet bikin kamu berdiri di pinggir jalan sambil ngutak-ngatik tas.',
      'Masalah tas harian bukan kapasitasnya, tapi kompartemennya. Semua barang masuk satu lubang, dan nyarinya jadi acara ngubek.'
    ],
    honest: [
      'Bukan tas anti air kelas outdoor. Kena hujan deras lama, bagian jahitan tetap bisa rembes.',
      'Klaim muat 15 inci itu optimistis. Laptop 14 inci masuk nyaman, 15 inci harus dipaksa sedikit.',
      'Warnanya bisa sedikit beda dari foto, tergantung layar dan batch.'
    ],
    reality: [
      'Realitanya dipakai buat kerja: laptop, charger, botol, kadang jaket. Yang bikin betah bukan talinya yang empuk, tapi karena nggak perlu mikir mau naruh di mana.',
      'Dan seperti kebanyakan tas: minggu pertama dirawat, bulan kedua dilempar ke sudut kamar.'
    ],
    psych: [
      'Beli tas itu kadang bukan karena yang lama rusak, tapi karena pengen kelihatan lebih rapi.',
      'Kita beli tas "buat kerja" padahal isinya lebih banyak snack daripada laptop.'
    ],
    pivot: [
      'Tapi dibanding tas yang jahitannya udah mau lepas, ganti sekarang lebih murah daripada kehilangan laptop.',
      'Bukan tas buat naik gunung. Tapi buat harian di kota, fungsinya udah lebih dari cukup.'
    ],
    questions: [
      'Tas kamu sekarang isinya rapi, atau kubangan barang?',
      'Pernah kehilangan sesuatu karena resleting tas kebuka sendiri?',
      'Berapa tas yang udah kamu beli dan sekarang nganggur?'
    ]
  },

  jashujan: {
    label: 'Jas Hujan', icon: '🧥',
    pains: [
      'Jas hujan murah biasanya bocor di jahitan, bukan di bahannya.',
      'Gerah. Sampai kantor malah basah kuyup dari keringat sendiri.',
      'Sobek di bagian ketiak setelah dipakai beberapa kali.'
    ],
    features: ['anti air', 'bahan elastis', 'setelan atasan & bawahan'],
    hooks: [
      'Jas hujan {{price}} yang nggak bikin gerah di jalan.',
      'Motoran hujan-hujanan tanpa berhenti nunggu reda.',
      'Yang bikin basah itu bukan hujannya, tapi jas hujan yang bocor.'
    ],
    visuals: [
      'Air disemprot ke permukaan jas, menggulir jadi butiran',
      'Jas dipakai naik motor, bagian ketiak masih bisa gerak',
      'Jas dilipat kecil, masuk ke bagasi motor'
    ],
    tags: ['jashujan', 'jashujanmotor', 'raincoat', 'jashujanmurah'],
    problems: [
      'Jas hujan murah biasanya bocor di jahitan, bukan di bahannya. Kamu baru sadar setelah sampai tujuan dan bagian dalam udah basah.',
      'Gerah itu masalah kedua. Yang pertama: pakai jas hujan plastik, keringatnya nggak bisa keluar, dan bau apeknya nempel.',
      'Sobek di ketiak setelah beberapa kali dipakai — karena jahitannya nggak sanggup nahan gerakan tangan.'
    ],
    honest: [
      'Ini bukan jas hujan kelas ekspedisi. Hujan deras berjam-jam, bagian jahitan tetap bisa tembus.',
      'Klaim "tebal" itu relatif. Tebal dibanding plastik kiloan, bukan dibanding jas hujan kulit.',
      'Ukuran agak longgar. Kalau biasa pakai M, pertimbangkan turun satu size.'
    ],
    reality: [
      'Realitanya dipakai 20 sampai 40 menit di jalan, lalu dilipat dan ditaruh di bagasi. Yang bikin betah bukan tebalnya, tapi karena nggak perlu berhenti tiap kali hujan.',
      'Dan seperti kebanyakan jas hujan: selalu dilipat asal-asalan, dan baru dicari saat hujan turun.'
    ],
    psych: [
      'Beli jas hujan itu bukan soal siap hujan, tapi soal nggak mau bergantung pada cuaca.',
      'Kita beli jas hujan karena males basah, bukan karena rajin bersih-bersih motor.'
    ],
    pivot: [
      'Tapi dibanding berhenti di pinggir jalan nunggu reda, satu jas hujan ini balik modal di hujan pertama.',
      'Bukan yang paling adem di kelasnya. Tapi buat hujan kota yang 20 menit, ini udah cukup.'
    ],
    questions: [
      'Jas hujan kamu sekarang masih utuh, atau udah sobek di ketiak?',
      'Kamu tim nerobos hujan, atau berhenti nunggu reda?',
      'Pernah sampai kantor basah bukan karena hujan?'
    ]
  },

  audio: {
    label: 'Audio', icon: '🔊',
    pains: [
      'Speaker murah biasanya suara pecah pas volume dinaikin.',
      'Bass hilang begitu lewat 70 persen.',
      'Kabel pendek, colokan longgar, dan akhirnya kiri mati.'
    ],
    features: ['daya besar', 'bluetooth', 'suara jernih di volume tinggi'],
    hooks: [
      'Speaker {{price}} yang nggak pecah di volume penuh.',
      'Bass-nya kerasa, padahal harganya segini.',
      'Buat yang males beli soundbar mahal.'
    ],
    visuals: [
      'Volume diputar sampai penuh, suara tetap bersih',
      'Speaker ditaruh di meja, gelas di sebelahnya ikut bergetar',
      'Bluetooth dipasangkan dari HP, langsung nyambung'
    ],
    tags: ['speaker', 'soundbar', 'audio', 'speakermurah'],
    problems: [
      'Speaker murah biasanya suara pecah pas volume dinaikin. Jadi ya dipakai di volume setengah, dan itu nggak ada gunanya.',
      'Bass hilang begitu lewat 70 persen. Yang tersisa cuma suara nyaring yang bikin kuping capek.',
      'Masalah audio murah bukan di besarnya suara, tapi di kabel dan colokan yang longgar setelah sebulan.'
    ],
    honest: [
      'Ini bukan audio referensi. Buat dengerin podcast dan musik harian, cukup. Buat mixing, jangan.',
      'Klaim watt itu biasanya watt puncak, bukan RMS. Jangan bayangin bisa buat acara di lapangan.',
      'Bluetooth-nya ada delay kecil. Buat video, kadang suara dan gambar nggak pas.'
    ],
    reality: [
      'Realitanya dipakai di kamar atau ruang kerja, bukan di panggung. Yang bikin betah bukan watt-nya, tapi karena nggak perlu nyalain TV buat dengerin musik.',
      'Dan seperti kebanyakan speaker: minggu pertama dipakai tiap hari, bulan kedua cuma jadi hiasan meja.'
    ],
    psych: [
      'Beli speaker itu bukan soal suara. Itu soal pengen kamar terasa lebih hidup.',
      'Kita beli speaker bagus, tapi yang diputar playlist yang sama sejak tiga tahun lalu.'
    ],
    pivot: [
      'Tapi dibanding speaker HP yang ditaruh di gelas, ini jelas beda kelas. Bukan hebat, tapi fungsinya utuh.',
      'Bukan soundbar bioskop. Tapi buat kamar 3x3, suaranya udah lebih dari cukup.'
    ],
    questions: [
      'Speaker kamu sekarang dipakai tiap hari, atau cuma jadi hiasan meja?',
      'Lebih sering dengerin musik, atau nonton YouTube?',
      'Pernah beli speaker murah yang pecah di volume tinggi?'
    ]
  },

  baju: {
    label: 'Baju', icon: '👕',
    pains: [
      'Baju murah biasanya bahannya tipis dan nerawang.',
      'Sekali cuci, bentuknya berubah.',
      'Jahitan ketiak gampang lepas kalau dipakai kerja.'
    ],
    features: ['bahan adem', 'jahitan rapi', 'potongan pas'],
    hooks: [
      'Baju {{price}} yang nggak nerawang dan nggak gerah.',
      'Buat yang tiap hari kerja di luar ruangan.',
      'Bahannya adem, padahal harganya segini.'
    ],
    visuals: [
      'Baju dipegang ke arah cahaya, tetap nggak nerawang',
      'Baju dipakai, lengan digerakkan, jahitan ketiak tetap rapi',
      'Baju dicuci, dijemur, bentuknya masih sama'
    ],
    tags: ['baju', 'kaos', 'bajuolahraga', 'bajumurah'],
    problems: [
      'Baju murah biasanya bahannya tipis dan nerawang. Kamu baru sadar setelah keluar rumah dan kena sinar matahari.',
      'Sekali cuci, bentuknya berubah. Bagian leher melar, panjangnya menyusut.',
      'Jahitan ketiak paling gampang lepas, terutama kalau dipakai kerja fisik.'
    ],
    honest: [
      'Ini bukan bahan premium. Setelah beberapa kali cuci, warna bisa sedikit pudar.',
      'Ukurannya standar, tapi potongannya cenderung pas badan. Kalau suka longgar, ambil satu size di atas.',
      'Jahitannya rapi, tapi bukan jahitan pabrik besar. Ada beberapa sisa benang yang perlu dipotong.'
    ],
    reality: [
      'Realitanya dipakai buat kerja atau olahraga ringan, lalu langsung dicuci. Yang bikin betah bukan modelnya, tapi karena nggak gerah walau dipakai seharian.',
      'Dan seperti kebanyakan baju: yang paling sering dipakai ya yang paling gampang dicuci.'
    ],
    psych: [
      'Beli baju olahraga itu kadang bukan buat olahraga, tapi buat merasa kayak orang yang olahraga.',
      'Kita beli 3 paket karena lebih murah, padahal yang dipakai cuma satu.'
    ],
    pivot: [
      'Tapi dibanding kaos biasa yang gerah, ini lebih masuk akal buat dipakai kerja fisik.',
      'Bukan baju teknis kelas atlet. Tapi buat lari pagi dan kerja ringan, fungsinya udah cukup.'
    ],
    questions: [
      'Baju olahraga kamu sekarang dipakai beneran, atau cuma buat tidur?',
      'Lebih sering beli 1 yang bagus, atau 3 yang murah?',
      'Pernah beli baju yang sekali cuci langsung melar?'
    ]
  },

  generic: {
    label: 'Produk', icon: '🛍️',
    pains: [
      'Barang murah belum tentu jelek, tapi harus teliti.',
      'Sebelum checkout, biasanya aku cek dua hal: bahan dan ulasan.',
      'Yang penting itu bukan harganya, tapi apakah worth dipakai harian.'
    ],
    features: ['harga di bawah pasaran', 'banyak repeat order', 'bisa COD'],
    hooks: [
      '{{name}} cuma {{price}}?',
      'Ini yang lagi rame di Shopee.',
      'Barang {{price}} yang ternyata worth it.'
    ],
    visuals: [
      'Close-up produk diputar 360 derajat',
      'Produk dipakai dalam aktivitas sehari-hari',
      'Tangan menunjuk detail bahan produk'
    ],
    tags: ['racunshopee', 'shopeehaul', 'belanjaonline', 'produkviral'],
    problems: [
      'Barang murah belum tentu jelek. Tapi barang murah yang nggak jelas asal-usulnya itu yang bikin kapok.',
      'Kita sering beli barang karena diskon, bukan karena butuh.',
      'Yang bikin nyesel bukan harganya, tapi barangnya yang nggak pernah dipakai.'
    ],
    honest: [
      'Ini bukan barang branded, dan tokonya bukan official store. Jadi jangan bandingin sama harga di mall.',
      'Foto produk biasanya lebih rapi dari barang aslinya. Baca ulasan yang ada fotonya dulu.',
      'Stoknya banyak, jadi bukan barang langka. Jangan beli karena takut kehabisan.'
    ],
    reality: [
      'Realitanya barang ini bakal dipakai sesekali, bukan tiap hari.',
      'Dan seperti kebanyakan barang online: datang, dibuka, dipakai sekali, lalu masuk lemari.'
    ],
    psych: [
      'Kenapa kita beli? Karena harganya di bawah ambang nggak perlu mikir.',
      'Di bawah 100rb, otak kita berhenti menghitung risiko.'
    ],
    pivot: [
      'Tapi buat fungsi yang kamu butuhin sekarang, ini udah cukup. Dan itu lebih baik daripada nunggu sampai bisa beli yang mahal.',
      'Bukan pembelian terbaik seumur hidup. Tapi bukan pemborosan juga.'
    ],
    questions: [
      'Kamu paling sering nyesel beli barang online karena apa?',
      'Barang terakhir yang kamu beli karena diskon, masih dipakai?',
      'Kamu tim baca ulasan dulu atau langsung checkout?'
    ]
  }
};

/* =========================================================
   Bank konten per plot (2, 3, 4) — dipisah dari CATS
   Plot 1 memakai CATS (problems/honest/reality/psych/pivot/questions)
   ========================================================= */
const PLOTS = {
  p1: { name: 'Honest Review', desc: 'Ulasan jujur & soft-selling' },
  p2: { name: 'Skeptis → Kemakan', desc: 'Ngaku salah sendiri, self-deprecating' },
  p3: { name: 'Matematika Orang Malas', desc: 'Hitung-hitungan kewarasan' },
  p4: { name: 'Dua Kubu', desc: 'Observasi kebiasaan, cari jalan tengah' }
};
const PLOT_ORDER = ['p1', 'p2', 'p3', 'p4'];

/* Peta slot per plot: dipakai untuk editor prompt di halaman Pengaturan.
   Slot tanpa titik (problems/honest/...) diambil dari CATS dan dipakai bersama antar plot;
   slot bertitik (p2.doubt, ...) diambil dari PLOT_DATA per kategori. */
const PLOT_SLOTS = {
  p1: [
    { key: 'problems',  label: 'Hook & masalah relatable', note: 'Pembuka post 1 — bikin orang ngerasa "ini gue"' },
    { key: 'honest',    label: 'Bedah klaim & sisi jujur',  note: 'Kekurangan yang diakui terbuka · dipakai juga di P2 & P3' },
    { key: 'reality',   label: 'Realita praktis',           note: 'Pemakaian sehari-hari yang sebenarnya · dipakai juga di P2, P3, P4' },
    { key: 'psych',     label: 'Sisi psikologis',           note: 'Kenapa orang tetap beli' },
    { key: 'pivot',     label: 'Pivot & kesimpulan',        note: 'Balik ke produk tanpa jualan keras' },
    { key: 'questions', label: 'Pancingan komentar',        note: 'Pertanyaan penutup · dipakai semua plot; 1 emoji ditambahkan otomatis' }
  ],
  p2: [
    { key: 'p2.doubt',   label: 'Keraguan awal',        note: 'Post 1 — kenapa awalnya nggak percaya' },
    { key: 'p2.trigger', label: 'Titik balik / kepepet', note: 'Momen yang bikin akhirnya beli' },
    { key: 'p2.sold',    label: 'Yang bikin kemakan',   note: 'Pengakuan setelah dipakai' },
    { key: 'honest',     label: 'Sisi jujur',           note: 'Dipakai bersama P1 & P3' },
    { key: 'reality',    label: 'Realita praktis',      note: 'Dipakai bersama P1, P3, P4' },
    { key: 'p2.close',   label: 'Penutup',              note: 'Kesimpulan santai' },
    { key: 'questions',  label: 'Pancingan komentar',   note: 'Dipakai bersama plot lain' }
  ],
  p3: [
    { key: 'p3.chore',   label: 'Pekerjaan receh',      note: 'Post 1 — hal kecil yang nggak pernah dihitung' },
    { key: 'p3.math',    label: 'Hitungan',             note: 'Angka & waktu yang dibuang' },
    { key: 'p3.limit',   label: 'Batas / limitasi',     note: 'Sampai mana hitungan ini masuk akal' },
    { key: 'honest',     label: 'Sisi jujur',           note: 'Dipakai bersama P1 & P2' },
    { key: 'reality',    label: 'Realita praktis',      note: 'Dipakai bersama P1, P2, P4' },
    { key: 'p3.close',   label: 'Penutup',              note: 'Kesimpulan hitungan' },
    { key: 'questions',  label: 'Pancingan komentar',   note: 'Dipakai bersama plot lain' }
  ],
  p4: [
    { key: 'p4.camps',    label: 'Dua kubu',            note: 'Post 1 — dua kebiasaan yang berlawanan' },
    { key: 'p4.middle',   label: 'Jalan tengah',        note: 'Posisi yang masuk akal' },
    { key: 'p4.physical', label: 'Bukti fisik produk',  note: 'Bahan, bentuk, dan hal yang bisa dicek' },
    { key: 'reality',     label: 'Realita praktis',     note: 'Dipakai bersama P1, P2, P3' },
    { key: 'p4.close',    label: 'Penutup',             note: 'Kesimpulan dua kubu' },
    { key: 'questions',   label: 'Pancingan komentar',  note: 'Dipakai bersama plot lain' }
  ]
};

/* Ambil bank kalimat default (tanpa editan user). */
function defaultLines(cat, slot) {
  if (slot.indexOf('.') > 0) {
    const parts = slot.split('.');
    const pd = PLOT_DATA[cat] || PLOT_DATA.generic;
    return (pd[parts[0]] && pd[parts[0]][parts[1]]) || [];
  }
  const c = CATS[cat] || CATS.generic;
  return c[slot] || [];
}

/* Ambil bank kalimat aktif: pakai editan user kalau ada, kalau tidak pakai default. */
function slotLines(cat, slot) {
  const ov = S && S.copy && S.copy[cat] && S.copy[cat][slot];
  if (Array.isArray(ov) && ov.length) return ov;
  return defaultLines(cat, slot);
}

const PLOT_DATA = {
  safety: {
    p2: {
      doubt: [
        'Awalnya aku mikir sepatu safety 84rb itu cuma sepatu biasa yang ditempeli kata safety biar kelihatan mahal.',
        'Jujur, aku sempat nganggep sepatu proyek murah itu sama aja kayak sepatu biasa, cuma warnanya lebih gelap.'
      ],
      trigger: [
        'Sampai suatu hari ngelangkah di area proyek yang lagi becek, dan sepatu lama langsung kemasukan air dalam hitungan detik.',
        'Titik baliknya waktu sol sepatu lama udah rata, dan tiap nginjak kerikil rasanya langsung nyampe telapak kaki.'
      ],
      sold: [
        'Yang bikin kemakan: ujung besinya beneran ada, dan solnya cukup tebal buat nahan kerikil. Bukan sensasi mewah, tapi fungsinya kerasa.',
        'Ternyata yang paling kepake bukan ujung besinya, tapi tinggi boot-nya yang nutup mata kaki waktu kena genangan.'
      ],
      close: [
        'Kadang barang yang kelihatan sepele justru yang paling sering dipakai. Sepatu ini sekarang paling depan di rak.',
        'Nggak nyangka yang akhirnya paling sering dipakai justru sepatu yang tadinya aku remehin.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak ada di job desc: ngecek kaki tiap habis keluar lokasi, takut ada paku nyangkut.',
        'Yang paling nguras emosi bukan kerjaannya, tapi mikirin kaki tiap kali lewat area berkerikil.'
      ],
      math: [
        'Kalau dihitung: 8 jam kerja, minimal 40 kali nginjak permukaan nggak rata. Dikali 20 hari kerja, itu 800 kali per bulan buat telapak kaki.',
        'Sepatu {{price}}, dipakai 6 bulan. Per hari jatuhnya nggak sampai 500 rupiah, lebih murah dari parkir.'
      ],
      limit: [
        'Bahannya sintetis, jadi jangan harap adem kayak kanvas. Kaki tetep keringetan, dan itu wajar.',
        'Ini bukan sepatu safety bersertifikat. Kalau proyekmu wajib SNI, ini bukan pilihan yang tepat.'
      ],
      close: [
        'Jadi beli sepatu ini bukan beli sepatu. Beli izin buat nggak mikirin kaki 8 jam sehari.',
        'Yang dibeli sebenarnya bukan sepatunya, tapi ketenangan tiap kali nginjak sesuatu yang nggak jelas.'
      ]
    },
    p4: {
      camps: [
        'Di proyek ada dua kubu: yang sepatunya dirawat tiap pulang, dan yang sepatunya dilempar di depan pintu sampai jebol sendiri.',
        'Soal sepatu kerja, orang terbagi dua: kubu yang penting aman, dan kubu yang penting masih bisa dipakai.'
      ],
      middle: [
        'Kubu pertama habis duit buat perawatan, kubu kedua habis duit buat beli ulang tiap 3 bulan. Dua-duanya capek.',
        'Yang satu kelamaan milih, yang satu keburu rusak. Jalan tengahnya sepatu yang cukup murah buat diganti, tapi cukup kuat buat dipakai.'
      ],
      physical: [
        'Fisiknya: bahan sintetis, tinggi sepanjang mata kaki, pengikat tali, ada pelat besi di ujung. Jahitan rapi, tapi lemnya kelihatan di beberapa titik.',
        'Yang bagus: sol tebal dan ujung besi. Yang biasa aja: insole bawaan tipis, sebaiknya tambah alas sendiri.'
      ],
      close: [
        'Alat sederhana kayak gini memang nggak nyelesaiin drama, tapi bikin dramanya nggak terjadi.',
        'Kadang yang bikin kerjaan adem bukan hal besar, tapi sepatu yang nggak bikin mikir.'
      ]
    }
  },

  sneakers: {
    p2: {
      doubt: [
        'Awalnya aku mikir sneakers 125rb itu cuma sepatu biar ada, bukan sepatu yang beneran enak dipakai.',
        'Jujur, aku sempat ngeremehin sneakers murah. Buat aku, di bawah 200rb itu artinya solnya keras.'
      ],
      trigger: [
        'Sampai suatu hari sepatu lama udah nggak bisa dipakai jalan jauh, dan aku harus jalan 1,5 km ke halte tiap pagi.',
        'Titik baliknya waktu aku jalan kaki 20 menit ke warung, dan telapak kaki protes keesokan harinya.'
      ],
      sold: [
        'Yang bikin kemakan: solnya empuk beneran. Bukan empuk kayak kasur, tapi cukup buat jalan 30 menit tanpa mikirin kaki.',
        'Ternyata yang paling kepake justru bobotnya yang ringan. Dipakai seharian, nggak berasa ada beban.'
      ],
      close: [
        'Kadang sepatu paling murah justru yang paling sering dipakai, karena nggak ada rasa sayang.',
        'Yang tadinya cuma buat jaga-jaga, sekarang jadi sepatu yang paling sering dipakai.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: milih sepatu tiap mau keluar rumah.',
        'Yang nguras emosi bukan jalannya, tapi mikirin sepatu apa yang nggak bikin kaki sakit hari ini.'
      ],
      math: [
        'Kalau punya satu sepatu yang bisa dipakai ke mana-mana, kamu hemat 5 menit tiap hari buat mikir. Sebulan jadi 2,5 jam.',
        'Hitung aja: 30 menit jalan kaki tiap hari. Kalau solnya nggak empuk, itu 30 menit mikirin kaki terus.'
      ],
      limit: [
        'Solnya empuk, tapi ini bukan sepatu lari. Dipakai lari 10K tiap hari, jangan harap setahun.',
        'Sol dan jahitannya bakal mulai minta ganti sebelum setahun. Ini bukan sepatu yang diwariskan.'
      ],
      close: [
        'Jadi beli sepatu ini bukan soal gaya. Ini bayar pajak kemalasan biar nggak mikir lagi tiap mau keluar.',
        'Yang dibeli bukan sepatunya, tapi keputusan yang nggak perlu diambil tiap pagi.'
      ]
    },
    p4: {
      camps: [
        'Soal sepatu harian, ada dua kubu: yang punya satu sepatu buat semua acara, dan yang punya lima tapi bingung mau pakai yang mana.',
        'Di rumah ada kubu sepatu harus matching sama outfit, dan kubu yang penting nggak bau.'
      ],
      middle: [
        'Kubu pertama kelamaan di depan lemari, kubu kedua keluar rumah pakai sandal jepit. Dua-duanya nggak ideal.',
        'Yang satu terlalu milih, yang satu nggak milih sama sekali. Jalan tengahnya sepatu netral yang aman dipakai ke mana aja.'
      ],
      physical: [
        'Fisiknya: bahan mesh dan kanvas, sol karet, pengikat tali. Ringan, dan bagian dalamnya cukup empuk.',
        'Yang bagus: ringan dan adem. Yang biasa aja: insole tipis, dan solnya nggak terlalu tebal buat jalan berbatu.'
      ],
      close: [
        'Sepatu yang netral nggak bikin kamu jadi pusat perhatian, tapi juga nggak bikin kamu keliatan salah kostum.',
        'Kadang yang ngurangin drama pagi bukan lemari baru, tapi satu sepatu yang bisa dipakai ke mana aja.'
      ]
    }
  },

  sandal: {
    p2: {
      doubt: [
        'Awalnya aku mikir sandal 34rb itu ya sandal. Nggak ada yang istimewa, dan pasti cepet putus.',
        'Jujur, aku nggak pernah percaya sama sandal murah yang ngaku empuk.'
      ],
      trigger: [
        'Sampai sandal lama putus di tengah jalan ke warung, dan aku harus pulang nyeker di paving yang panas.',
        'Titik baliknya waktu kepleset di kamar mandi gara-gara sol sandal udah licin.'
      ],
      sold: [
        'Yang bikin kemakan: bantalannya beneran empuk. Bukan empuk maksa, tapi cukup buat jalan 15 menit ke warung tanpa kapalan.',
        'Ternyata yang paling kepake justru ringannya. Dipakai ke mana-mana, nggak berasa ada yang nempel.'
      ],
      close: [
        'Sekarang sandal ini yang paling sering dipakai, justru karena harganya bikin nggak mikir.',
        'Yang tadinya cuma buat di kamar mandi, sekarang jadi sandal yang dipakai ke mana-mana.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: bolak-balik ke warung, ke teras, ke kamar mandi, 20 kali sehari.',
        'Yang nguras emosi bukan jalannya, tapi tiap kali harus pakai sandal yang solnya licin.'
      ],
      math: [
        'Kalau sehari 20 kali bolak-balik, sebulan jadi 600 kali. Sandal yang nggak nyaman itu 600 kali kesempatan buat kesal.',
        'Sandal {{price}}, dipakai 8 bulan. Per hari jatuhnya nggak sampai 150 rupiah, lebih murah dari sekali parkir.'
      ],
      limit: [
        'Bahannya EVA, ringan, tapi gampang kempes kalau kena panas mesin cuci.',
        'Solnya berpola, tapi ini bukan sandal gunung. Jangan harap nge-grip di lantai berlumut.'
      ],
      close: [
        'Jadi beli sandal ini bukan beli sandal. Beli izin buat nggak mikirin kaki tiap ke kamar mandi.',
        'Yang dibeli bukan sandalnya, tapi 600 kali jalan yang nggak bikin kesal.'
      ]
    },
    p4: {
      camps: [
        'Soal sandal rumah, ada dua kubu: yang sandalnya selalu rapi di rak, dan yang sandalnya selalu hilang satu.',
        'Di rumah ada kubu sandal khusus dalam rumah, dan kubu sandal satu buat semua tempat.'
      ],
      middle: [
        'Kubu pertama habis waktu nyari pasangan, kubu kedua bikin lantai kotor. Dua-duanya bikin capek.',
        'Yang satu terlalu rapi, yang satu terlalu cuek. Jalan tengahnya sandal murah yang boleh dipakai ke mana aja tanpa rasa sayang.'
      ],
      physical: [
        'Fisiknya: bahan EVA, sol berpola, ringan banget. Warna sesuai foto, tapi ada sedikit sisa cetakan di pinggir.',
        'Yang bagus: ringan dan empuk. Yang biasa aja: baunya agak plastik di hari pertama.'
      ],
      close: [
        'Sandal murah yang boleh dipakai ke mana aja itu ngurangin satu sumber pertengkaran kecil di rumah.',
        'Kadang yang bikin rumah adem bukan sofa baru, tapi sandal yang nggak bikin rebutan.'
      ]
    }
  },

  hoodie: {
    p2: {
      doubt: [
        'Awalnya aku mikir hoodie 69rb itu cuma kain tebal yang dijahit jadi jaket. Nggak ada istimewanya.',
        'Jujur, aku sempat ngeremehin hoodie murah. Biasanya bahannya gerah dan berbulu di dalam.'
      ],
      trigger: [
        'Sampai suatu malam naik motor jam 10, dan jaket lama udah nggak bisa nahan angin sama sekali.',
        'Titik baliknya waktu jaket lama ketinggalan di kos, dan aku harus keluar malam cuma pakai kaos.'
      ],
      sold: [
        'Yang bikin kemakan: bahannya beneran nahan angin. Bukan hangat kayak jaket gunung, tapi cukup buat motoran malam.',
        'Ternyata yang paling kepake justru tudungnya. Dipakai naik motor, leher nggak kedinginan.'
      ],
      close: [
        'Sekarang hoodie ini yang paling sering dipakai, justru karena nggak perlu mikir mau padu sama apa.',
        'Yang tadinya aku anggap jaket murahan, sekarang jadi yang paling sering dipakai.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: mikirin mau pakai jaket apa tiap mau keluar malam.',
        'Yang nguras emosi bukan dinginnya, tapi tiap keluar malam harus milih antara kedinginan atau kegerahan.'
      ],
      math: [
        'Kalau tiap malam naik motor 30 menit, sebulan jadi 15 jam kena angin. Jaket yang nggak nahan angin itu 15 jam kedinginan.',
        'Hoodie {{price}} dipakai 2 tahun. Per bulan jatuhnya nggak sampai 3rb, lebih murah dari sekali kopi.'
      ],
      limit: [
        'Bahannya katun fleece, tebalnya di tengah. Jangan bayangin hoodie musim dingin.',
        'Bonus topinya random, jadi jangan berharap warnanya nyambung.'
      ],
      close: [
        'Jadi beli hoodie ini bukan beli jaket. Beli izin buat nggak mikirin dingin tiap keluar malam.',
        'Yang dibeli bukan hoodienya, tapi 15 jam per bulan yang nggak bikin menggigil.'
      ]
    },
    p4: {
      camps: [
        'Soal jaket, ada dua kubu: yang jaketnya dilipat rapi di lemari, dan yang jaketnya numpuk di kursi sampai nggak muat diduduki.',
        'Di kos ada kubu jaket satu buat semua acara, dan kubu jaket harus sesuai outfit.'
      ],
      middle: [
        'Kubu pertama keluar malam pakai jaket yang salah, kubu kedua nggak punya tempat duduk. Dua-duanya nggak ideal.',
        'Yang satu kebanyakan pilihan, yang satu nggak punya pilihan. Jalan tengahnya satu hoodie netral yang aman dipakai ke mana aja.'
      ],
      physical: [
        'Fisiknya: katun fleece, lengan panjang, ada tudung, tersedia ukuran jumbo. Jahitannya rapi, tapi bagian dalam agak berbulu di awal.',
        'Yang bagus: tebal dan hangat. Yang biasa aja: talinya tipis, dan kantongnya nggak terlalu dalam.'
      ],
      close: [
        'Hoodie netral itu ngurangin satu keputusan kecil tiap hari, dan kadang itu yang bikin hidup terasa lebih gampang.',
        'Kadang yang bikin kamar kos terasa nyaman bukan AC baru, tapi jaket yang selalu siap dipakai.'
      ]
    }
  },

  jeans: {
    p2: {
      doubt: [
        'Awalnya aku mikir jeans 150rb itu ya jeans. Pasti kaku, dan pasti melar setelah dua kali cuci.',
        'Jujur, aku udah kapok beli jeans online. Fotonya bagus, bahannya kayak karton.'
      ],
      trigger: [
        'Sampai jeans lama udah nggak bisa dipakai duduk lama, karena pinggangnya ngunci.',
        'Titik baliknya waktu harus duduk 3 jam di acara, dan jeans lama bikin nggak betah.'
      ],
      sold: [
        'Yang bikin kemakan: bahannya stretch beneran. Duduk lama, naik motor, masih nyaman.',
        'Ternyata yang paling kepake justru potongan highwaist-nya. Nggak perlu narik-narik jeans tiap kali berdiri.'
      ],
      close: [
        'Sekarang jeans ini yang paling sering dipakai, justru karena nggak perlu mikirin apa-apa.',
        'Yang tadinya aku anggap sama aja, sekarang jadi celana yang paling sering dipakai.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: narik pinggang jeans tiap kali berdiri dari duduk.',
        'Yang nguras emosi bukan acaranya, tapi mikirin jeans ini masih muat nggak ya tiap mau pergi.'
      ],
      math: [
        'Kalau sehari duduk-berdiri 30 kali, sebulan jadi 900 kali. Jeans yang nggak stretch itu 900 kali tarik pinggang.',
        'Jeans {{price}} dipakai 2 tahun. Per bulan jatuhnya 6rb, lebih murah dari sekali nongkrong.'
      ],
      limit: [
        'Bahannya denim stretch, jadi ada batasnya. Jangan dipaksa muat kalau size-nya udah mepet.',
        'Warna bisa sedikit beda dari foto, dan cuci pertama sebaiknya dipisah dari baju putih.'
      ],
      close: [
        'Jadi beli jeans ini bukan beli celana. Beli izin buat duduk dan berdiri tanpa mikir.',
        'Yang dibeli bukan jeansnya, tapi 900 kali gerakan yang nggak bikin kesal.'
      ]
    },
    p4: {
      camps: [
        'Soal jeans, ada dua kubu: yang nyuci tiap dua kali pakai, dan yang nyuci kalau udah nggak ada bau parfum.',
        'Di rumah ada kubu jeans harus pas di badan, dan kubu yang penting bisa duduk.'
      ],
      middle: [
        'Kubu pertama nggak bisa duduk nyaman, kubu kedua keliatan kayak pakai sarung. Dua-duanya ada harganya.',
        'Yang satu ngorbankan kenyamanan, yang satu ngorbankan penampilan. Jalan tengahnya jeans stretch yang masih kelihatan rapi.'
      ],
      physical: [
        'Fisiknya: denim stretch, potongan highwaist, model cutbray. Jahitan rapi, tapi kancingnya agak ringan.',
        'Yang bagus: stretch dan potongannya. Yang biasa aja: kantongnya dangkal, dan warnanya bisa luntur di cuci pertama.'
      ],
      close: [
        'Jeans yang pas itu ngurangin satu drama pagi, dan itu lumayan.',
        'Kadang yang bikin hidup lebih gampang bukan lemari baru, tapi satu celana yang nggak bikin mikir.'
      ]
    }
  },

  tumbler: {
    p2: {
      doubt: [
        'Awalnya aku mikir tumbler 64rb itu cuma botol mahal. Air tetap air, es tetap es.',
        'Jujur, aku sempat nganggep tumbler itu barang buat orang rajin. Aku bukan orang rajin.'
      ],
      trigger: [
        'Sampai suatu hari beli es teh 3 kali dalam sehari, dan sadar udah keluar 30rb cuma buat minum.',
        'Titik baliknya waktu es batu di botol plastik leleh dalam 2 jam, dan airnya jadi anget.'
      ],
      sold: [
        'Yang bikin kemakan: esnya beneran masih ada sampai sore. Bukan 12 jam kayak klaim, tapi cukup.',
        'Ternyata yang paling kepake justru kapasitas 900ml-nya. Sekali isi, cukup sampai pulang.'
      ],
      close: [
        'Sekarang tumbler ini yang paling sering dibawa, justru karena nggak perlu mikir mau minum apa.',
        'Yang tadinya aku anggap gimmick, sekarang jadi barang yang paling sering kena tangan.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: keluar beli minum, antre, balik lagi ke meja.',
        'Yang nguras emosi bukan hausnya, tapi mikirin mau minum apa tiga kali sehari.'
      ],
      math: [
        'Kalau beli es teh 10rb tiap hari, sebulan 300rb. Tumbler {{price}} itu balik modal dalam seminggu.',
        'Sekali isi ulang hemat 10rb dan 10 menit antre. Sebulan jadi 300rb dan 5 jam.'
      ],
      limit: [
        'Ini stainless steel, tapi bukan vacuum double-wall premium. Klaim 8 jam itu dari toko, realitanya tergantung isi.',
        'Warna tutupnya random. Kalau kamu butuh serba matching, ini bakal sedikit mengganggu.'
      ],
      close: [
        'Jadi beli tumbler ini bukan beli botol. Beli izin buat nggak keluar ruangan tiap haus.',
        'Yang dibeli bukan tumbler-nya, tapi 5 jam sebulan yang nggak habis buat antre.'
      ]
    },
    p4: {
      camps: [
        'Soal minum, ada dua kubu: yang bawa botol ke mana-mana, dan yang tiap hari beli es teh.',
        'Di kantor ada kubu tumbler harus dicuci tiap hari, dan kubu yang penting masih ada air.'
      ],
      middle: [
        'Kubu pertama repot nyuci, kubu kedua repot keluar beli. Dua-duanya makan waktu.',
        'Yang satu terlalu ribet, yang satu terlalu boros. Jalan tengahnya tumbler besar yang cukup diisi sekali sehari.'
      ],
      physical: [
        'Fisiknya: stainless steel 900ml, ada sedotan, tutup ulir. Beratnya lumayan, tapi masih muat di ransel.',
        'Yang bagus: kapasitas dan ketahanan suhu. Yang biasa aja: tutupnya random, dan nggak muat di holder motor kecil.'
      ],
      close: [
        'Satu tumbler di meja itu ngurangin satu alasan buat keluar ruangan.',
        'Kadang yang bikin hari lebih rapi bukan aplikasi baru, tapi botol yang selalu ada di meja.'
      ]
    }
  },

  case: {
    p2: {
      doubt: [
        'Awalnya aku mikir case AirPods 13rb itu cuma silikon murah yang bakal kuning seminggu kemudian.',
        'Jujur, aku nggak pernah ngerti kenapa orang beli case buat barang yang udah ada casing-nya.'
      ],
      trigger: [
        'Sampai AirPods-ku jatuh di parkiran, dan casing-nya lecet parah. Bukan rusak, tapi bikin kesal tiap lihat.',
        'Titik baliknya waktu AirPods jatuh dari meja, dan aku mikir ini bakal mahal.'
      ],
      sold: [
        'Yang bikin kemakan: pas banget, nggak longgar. Dan pas dibuka, AirPods-nya nggak ikut ketarik.',
        'Ternyata yang paling kepake justru tebalnya yang tipis. Masuk saku, nggak berasa ada case.'
      ],
      close: [
        'Sekarang case ini yang bikin aku berhenti deg-degan tiap AirPods jatuh.',
        'Yang tadinya aku anggap nggak penting, sekarang jadi barang yang nggak bisa dilepas.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: ngecek AirPods tiap kali jatuh, takut ada yang retak.',
        'Yang nguras emosi bukan jatuhnya, tapi mikirin ini rusak nggak ya tiap dengar bunyi jatuh.'
      ],
      math: [
        'AirPods 2 juta. Case {{price}} itu kurang dari 1 persen dari harganya. Kalau lecet sekali aja, nyeselnya lebih dari itu.',
        'Kalau sehari AirPods jatuh 2 kali, sebulan 60 kali. Case {{price}} itu bayaran buat 60 kali nggak deg-degan.'
      ],
      limit: [
        'Bahannya silikon TPU, empuk, tapi tetap bisa kuning kalau kena matahari terus.',
        'Ini bukan case anti air. Jangan harap bisa kena hujan deras.'
      ],
      close: [
        'Jadi beli case ini bukan beli aksesori. Beli izin buat nggak mikirin barang 2 juta tiap kali jatuh.',
        'Yang dibeli bukan case-nya, tapi 60 kali deg-degan yang nggak perlu.'
      ]
    },
    p4: {
      camps: [
        'Soal AirPods, ada dua kubu: yang casing-nya dibungkus rapi, dan yang casing-nya udah lecet kayak barang bekas.',
        'Di rumah ada kubu barang mahal harus dilindungi, dan kubu yang penting masih bunyi.'
      ],
      middle: [
        'Kubu pertama keluar duit buat case, kubu kedua keluar duit buat ganti. Dua-duanya ada ongkosnya.',
        'Yang satu terlalu protektif, yang satu terlalu cuek. Jalan tengahnya case murah yang cukup buat nahan baret.'
      ],
      physical: [
        'Fisiknya: silikon TPU bening, pas untuk Gen 1 sampai Pro 2. Ada sedikit sisa cetakan di bagian dalam.',
        'Yang bagus: pas dan nggak longgar. Yang biasa aja: tombolnya agak keras, dan beningnya bisa kuning.'
      ],
      close: [
        'Case murah itu ngurangin satu kekhawatiran kecil, dan kadang itu cukup.',
        'Kadang yang bikin tenang bukan asuransi, tapi case {{price}} yang bikin barang mahal nggak telanjang.'
      ]
    }
  },

  generic: {
    p2: {
      doubt: [
        'Awalnya aku mikir barang {{price}} itu ya barang murahan yang bakal rusak sebulan kemudian.',
        'Jujur, aku sempat ngeremehin barang murah. Biasanya bagus di foto, jelek di tangan.'
      ],
      trigger: [
        'Sampai barang lama rusak di saat yang paling nggak pas, dan aku nggak punya pengganti.',
        'Titik baliknya waktu barang lama udah nggak bisa dipakai lagi, dan aku males keluar rumah buat beli.'
      ],
      sold: [
        'Yang bikin kemakan: fungsinya jalan, dan nggak ada bagian yang bikin kesal.',
        'Ternyata yang paling kepake justru hal kecil yang nggak aku pertimbangin waktu beli.'
      ],
      close: [
        'Kadang barang paling murah justru yang paling sering dipakai.',
        'Yang tadinya cuma buat jaga-jaga, sekarang jadi barang yang paling sering kena tangan.'
      ]
    },
    p3: {
      chore: [
        'Ada pekerjaan receh yang nggak pernah dihitung: nyari barang yang selalu hilang tiap mau dipakai.',
        'Yang nguras emosi bukan kerjaannya, tapi mikirin barang ini ada di mana.'
      ],
      math: [
        'Kalau tiap hari nyari 5 menit, sebulan jadi 2,5 jam. Itu waktu yang nggak bisa balik.',
        'Barang {{price}} dipakai setahun. Per bulan jatuhnya nggak sampai 10rb, lebih murah dari sekali makan di luar.'
      ],
      limit: [
        'Ini bukan barang branded, dan tokonya bukan official store. Finishing-nya biasa aja.',
        'Foto produk lebih rapi dari barang aslinya. Baca ulasan yang ada fotonya dulu.'
      ],
      close: [
        'Jadi beli ini bukan beli barang. Beli izin buat nggak mikirin hal receh.',
        'Yang dibeli bukan barangnya, tapi 2,5 jam sebulan yang nggak habis buat nyari.'
      ]
    },
    p4: {
      camps: [
        'Ada dua kubu: yang barangnya rapi di tempatnya, dan yang barangnya hilang tiap mau dipakai.',
        'Di rumah ada kubu yang nyimpen struk belanja, dan kubu yang nggak pernah tahu barangnya ke mana.'
      ],
      middle: [
        'Yang satu kelamaan nyari, yang satu beli ulang terus. Dua-duanya boros waktu.',
        'Yang satu terlalu rapi, yang satu terlalu cuek. Jalan tengahnya barang murah yang gampang diganti.'
      ],
      physical: [
        'Fisiknya sesuai deskripsi. Finishing-nya biasa aja, tapi fungsinya jalan.',
        'Yang bagus: sesuai harga. Yang biasa aja: detail kecil kayak jahitan dan warna.'
      ],
      close: [
        'Kadang yang bikin hidup lebih gampang bukan barang mahal, tapi barang yang selalu ada.',
        'Alat sederhana seringkali yang paling ngurangin drama kecil di rumah.'
      ]
    }
  }
};

function parsePrice(t) {
  if (t == null) return 0;
  const s = String(t).toLowerCase().replace(/rp\.?/g, '').replace(/\s/g, '');
  const m = s.match(/([\d.,]+)(rb|ribu|k|jt|juta)?/);
  if (!m) return 0;
  let num = m[1];
  const unit = m[2] || '';
  if (/jt|juta/.test(unit)) {
    num = num.replace(/\./g, '').replace(',', '.');
    return Math.round((parseFloat(num) || 0) * 1000000);
  }
  if (unit) {
    num = num.replace(/\./g, '').replace(',', '.');
    return Math.round((parseFloat(num) || 0) * 1000);
  }
  num = num.replace(/\./g, '').replace(',', '.');
  return Math.round(parseFloat(num) || 0);
}

function parseSold(t) {
  if (t == null) return 0;
  const s = String(t).toLowerCase().replace(/\s|\+/g, '');
  const m = s.match(/([\d.,]+)(rb|ribu|k)?/);
  if (!m) return 0;
  let v = parseFloat(m[1].replace(/\./g, '').replace(',', '.')) || 0;
  if (m[2]) v *= 1000;
  return Math.round(v);
}

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
      else if (c !== '\r') cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row); }
  return rows;
}

/* Tebak kategori dari nama produk. CSV affiliate Shopee tidak punya kolom
   kategori, jadi ini satu-satunya sumber.

   URUTAN PENTING: aturan yang lebih spesifik diperiksa lebih dulu. Contoh,
   "SEPATU SAFETY" harus jadi safety, bukan sneakers. Dan "BAJU OLAHRAGA KAOS
   SPORT RUNNING" harus jadi baju — dulu kata "sport"/"running" dianggap
   sneakers, sehingga baju kaos dikira sepatu lari. */
function detectCat(name) {
  const n = (name || '').toLowerCase();
  if (/safety|boots|ujung besi|kerja proyek/.test(n)) return 'safety';
  if (/jas hujan|raincoat|ponco|jas ujan/.test(n)) return 'jashujan';
  if (/sandal|sendal|jelly|slop/.test(n)) return 'sandal';
  if (/hoodie|sweater|jaket/.test(n)) return 'hoodie';
  if (/jeans|cutbray|celana panjang/.test(n)) return 'jeans';
  if (/\btas\b|ransel|backpack|hydropack|sling ?bag|koper/.test(n)) return 'tas';
  if (/amplifier|speaker|soundbar|sounbar|subwoofer|woofer|headset|headphone|earphone|\btws\b|microphone/.test(n)) return 'audio';
  if (/baju|kaos|kemeja|\bpolo\b|jersey|\bgym\b|olahraga|celana pendek/.test(n)) return 'baju';
  if (/tumbler|botol/.test(n)) return 'tumbler';
  if (/airpods|\bcase\b/.test(n)) return 'case';
  if (/sneakers|sepatu/.test(n)) return 'sneakers';
  return 'generic';
}

/* ---------------- generator ---------------- */
function catOf(item) { return CATS[item.category] || CATS.generic; }

// "64,0RB" -> "64rb" ; "104,8RB" -> "104,8rb"
function priceLabel(item) {
  return String(item.priceText || '0').replace(/RB/i, 'rb').replace(/,0rb$/i, 'rb');
}
// buang titik/koma di akhir nama toko supaya tidak jadi ".." saat dirangkai kalimat
function shopName(item) {
  return String(item.shop || '').replace(/[\s.,;:]+$/, '');
}

function tpl(str, item) {
  return String(str)
    .replace(/\{\{price\}\}/g, priceLabel(item))
    .replace(/\{\{sold\}\}/g, item.soldText)
    .replace(/\{\{shop\}\}/g, shopName(item))
    .replace(/\{\{name\}\}/g, item.name.split(',')[0].slice(0, 60));
}

/* --- data detail hasil ekstraksi Chrome headless (detail.js) --- */
function specMap(item) {
  const d = item.detail;
  const map = {};
  if (!d || !d.specs) return map;
  String(d.specs).split('|').forEach((s) => {
    const i = s.indexOf(':');
    if (i > 0) map[s.slice(0, i).trim().toLowerCase()] = s.slice(i + 1).trim();
  });
  return map;
}

function detailFacts(item) {
  const kv = specMap(item);
  const out = [];
  const add = (x) => { if (x && !out.includes(x)) out.push(x); };
  const bahan = (kv['bahan'] || '').toLowerCase();
  if (bahan && bahan.length < 40 && !/sintetis|tidak|lainnya|belum ada/.test(bahan)) add('bahan ' + bahan);
  if (kv['kapasitas volume']) add('kapasitas ' + kv['kapasitas volume'].toLowerCase());
  if (/bebas bpa|bpa free/i.test(kv['fitur popok'] || '')) add('BPA free');
  if (kv['tinggi pinggang']) add(kv['tinggi pinggang'].toLowerCase());
  if (/^ya$/i.test(kv['ukuran jumbo'] || '')) add('ada ukuran jumbo');
  if (kv['jenis kelamin']) add(kv['jenis kelamin'].toLowerCase());
  if (kv['panjang lengan']) add(kv['panjang lengan'].toLowerCase());
  if (kv['panjang celana']) add(kv['panjang celana'].toLowerCase());
  return out;
}

function descBullets(item) {
  const d = item.detail;
  if (!d || !d.raw_description) return [];
  const noise = /selamat datang|chat admin|reseller|dropship|real\s?pict|follow|testimoni|no refund|klik link|cek ulasan|jangan lupa|harga boleh|^adalah |^kami |^kamu |^toko |semua produk|menerima|kualitas terjamin|standart distro|^pengiriman |^dikirim |cara pembelian|pembelian|proses beli|aman dan nyaman|mudah\s*,/i;
  const seen = new Set();
  const out = [];
  String(d.raw_description).split('\n').forEach((raw) => {
    let l = raw.replace(/^[\s•*\-–—✓~=>()\[\]]+/, '').replace(/[{}]/g, '').trim();
    if (l.length < 14 || l.length > 60) return;
    if (/https?:/.test(l) || noise.test(l)) return;
    if (claimLine(l)) return;                        // klaim terlarang tidak masuk bahan prompt
    if (/[:]/.test(l)) return;                       // baris format "Size : 31-35", "Type: ..."
    if (/sintetis|100%|original|garansi|bpom|sni/i.test(l)) return; // klaim yang tidak bisa diverifikasi
    if (/cantumkan|silahkan|harap|pastikan|ukuran kaki|proses beli|chat|note|catatan/i.test(l)) return; // instruksi ke pembeli
    if (!/tahan|anti|empuk|nyaman|tebal|ringan|bahan|kapasitas|muat|bonus|gratis|unisex|jumbo|stretch|waterproof|bpa|sedotan|awet/i.test(l)) return;
    if (!/[a-zA-Z]/.test(l)) return;
    const key = l.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l.charAt(0).toUpperCase() + l.slice(1));
  });
  return out;
}

function featuresOf(item) {
  const cat = catOf(item);
  const n = (item.name || '').toLowerCase();
  const out = [];
  const lastWord = (x) => (String(x).toLowerCase().split(/[^a-z0-9\u2013]+/).filter(Boolean).pop() || '');
  const add = (x) => {
    if (!x) return;
    const lx = x.toLowerCase();
    if (out.some((y) => y.toLowerCase() === lx)) return;
    const lw = lastWord(x);
    if (lw && lw.length > 2 && out.some((y) => lastWord(y) === lw)) return;
    out.push(x);
  };
  if (/ujung besi|steel\s*toe/.test(n)) add('ujung besi (steel toe)');
  if (/bayar di tempat|\bcod\b/.test(n)) add('bisa COD / bayar di tempat');
  if (/stainless/.test(n)) add('stainless steel');
  if (/tahan panas/.test(n)) add('tahan panas & dingin');
  if (/900ml/.test(n)) add('kapasitas 900ml');
  if (/highwaist|high waist/.test(n)) add('potongan highwaist');
  if (/strea?ch/.test(n)) add('bahan stretch');
  if (/cutbray/.test(n)) add('model cutbray');
  if (/bonus topi/.test(n)) add('bonus topi');
  if (/fleece|pleece/.test(n)) add('bahan fleece tebal');
  if (/premium/.test(n)) add('bahan premium');
  if (/jelly/.test(n)) add('bahan jelly empuk');
  if (/empuk/.test(n)) add('bantalannya empuk');
  if (/gen 1 2 3 4|pro 2/.test(n)) add('support Gen 1–4 & Pro');
  if (/import/.test(n)) add('kualitas import');
  detailFacts(item).forEach(add);
  cat.features.forEach(add);
  descBullets(item).filter((l) => l.length >= 18).slice(0, 1).forEach(add);
  /* "Uang kembali dan ganti rugi ongkos kirim" pernah lolos ke baris
     "Fitur utama" lalu dipakai Writer sebagai janji — persis yang dilarang
     R-05. Fitur yang memuat klaim terlarang dibuang di sini. */
  return out.filter((f) => !claimLine(f)).slice(0, 4);
}

function cutText(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'), slice.lastIndexOf('? '));
  return (stop > max * 0.55 ? slice.slice(0, stop + 1) : slice).trim();
}

function threadText(item) {
  const posts = (plat(item, 'threads') && plat(item, 'threads').posts) || [];
  return posts.join('\n\n-----\n\n');
}

/* Utas Threads: 3-5 post, tiap post <= 500 karakter, dipisah "-----" */
function linkCurious(item) {
  /* Kalimat pengungkapan afiliasi sengaja ikut di blok link, bukan diselipkan
     di badan utas: pembaca berhak tahu sebelum menekan, bukan sesudahnya.
     Ini juga yang memenuhi R-08 di rulebook. */
  return { t: `Kalau mau lihat varian sama deskripsi tokonya (di situ biasanya ketahuan mana yang jujur, mana yang cuma jualan), ini link afiliasinya:\n${item.affiliateUrl}\nAku dapat komisi kalau kamu beli dari sini — harga kamu tetap sama.`, atomic: true };
}

/* panduan ukuran asli dari deskripsi seller */
function sizeNote(item) {
  const d = item.detail;
  if (!d || !d.raw_description) return '';
  const flat = String(d.raw_description).replace(/\r/g, '').replace(/\s+/g, ' ');

  const warn = flat.match(/(?:lebih kecil|lebih besar|kekecilan|kebesaran)[^.]{0,90}?(?:naik|turun|tambah|kurang)\w*\s*(\d)?\s*size/i)
    || flat.match(/(?:harap|disarankan|sarankan|sebaiknya)\s*(?:naik|turun|tambah)\s*(\d)\s*size/i);
  if (warn) {
    const n = warn[1] || '1';
    const bigger = /lebih besar|kebesaran/i.test(warn[0]);
    return `Catatan dari tokonya sendiri: ukurannya ${bigger ? 'lebih besar' : 'lebih kecil'} dari biasanya, jadi ambil ${n} size di ${bigger ? 'bawah' : 'atas'} yang biasa kamu pakai.`;
  }

  const pairs = [];
  const re = /(\d{2})\s*[:=]\s*(?:untuk\s+panjang\s+kaki\s*)?(\d{2}(?:[.,]\d+)?)\s*(?:cm)?/gi;
  let m;
  while ((m = re.exec(flat)) && pairs.length < 3) {
    const s = +m[1];
    const c = parseFloat(String(m[2]).replace(',', '.'));
    if (s >= 30 && s <= 46 && c >= 18 && c <= 32) pairs.push([s, c]);
  }
  const fmt = (x) => String(x).replace('.', ',');
  if (pairs.length >= 2) {
    const a = pairs[0];
    const b = pairs[pairs.length - 1];
    return `Panduan ukurannya jelas: size ${a[0]} = ${fmt(a[1])} cm, size ${b[0]} = ${fmt(b[1])} cm. Jadi ukur panjang kaki dulu, jangan tebak.`;
  }

  const r = flat.match(/size\s*[:=]?\s*(\d{2})\s*[-–]\s*(\d{2})/i);
  if (r) return `Varian ukurannya dari size ${r[1]} sampai ${r[2]}, jadi masih ada ruang buat cari yang pas.`;

  const waist = flat.match(/lingkar pinggang\s*[:=]?\s*(\d{2})\s*cm/i);
  if (waist) return `Lingkar pinggangnya ${waist[1]} cm di ukuran terkecil, jadi ukur dulu pinggangmu sebelum checkout.`;

  const bb = flat.match(/(?:berat badan|bb)\s*[:=]?\s*(\d{2})\s*[-–]\s*(\d{2})\s*kg/i)
    || flat.match(/(\d{2})\s*[-–]\s*(\d{2})\s*kg/i);
  if (bb) return `Patokan dari tokonya pakai berat badan ${bb[1]}–${bb[2]} kg, bukan tinggi badan. Jadi sesuaikan sama badanmu.`;

  return '';
}

/* asal pengiriman + jumlah varian */
function shipNote(item) {
  const d = item.detail;
  if (!d) return '';
  const loc = String(d.shop_location || '').trim()
    .replace(/\bKAB\.\s*/i, 'Kab. ')
    .replace(/\bKOTA\s*/i, 'Kota ')
    .toLowerCase()
    .replace(/(^|[\s.])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  const mv = String(d.variations || '').match(/Total\s*(\d+)\s*varian/i);
  if (!loc) return '';
  return `Dikirim dari ${loc}${mv ? `, total ${mv[1]} varian` : ''}.`;
}

/* kumpulan blok pendukung: dipakai seperlunya untuk mengisi panjang post */
/* Deteksi beat yang isinya mengulang beat lain. Dipakai supaya "sisi jujur"
   tidak muncul dua kali berturut-turut, dan supaya catatan pengiriman/ukuran

/* Plot 1 — Honest Review
   Satu beat "bedah" saja. Dulu ada dua baris dari slot honest berurutan, dan
   hasilnya terbaca sebagai pengulangan — bukan kedalaman. Kedalaman dijaga

/* pilih plot yang paling sedikit dipakai supaya distribusi tetap seimbang */
function nextPlot() {
  const counts = {};
  PLOT_ORDER.forEach((p) => { counts[p] = S.items.filter((i) => i.plot === p).length; });
  return PLOT_ORDER.slice().sort((a, b) => counts[a] - counts[b])[0];
}

/* ---------------- model platform ----------------
   Satu item punya beberapa platform. Tiap platform menyimpan SATU revisi aktif
   plus riwayat revisi lama. Regenerate menaikkan rev dan mengarsipkan revisi
   sebelumnya — tidak pernah menimpanya, karena revisi lama bisa jadi sudah tayang. */

const PLATFORM_KEYS = ['threads', 'tiktok'];
const SCHEMA_VERSION = 6;
const MAX_HISTORY = 5;      // batasi supaya isi database tidak bengkak

const CONTENT_FIELDS = {
  threads: ['posts'],
  tiktok: ['hook', 'scenes', 'caption', 'hashtags', 'coverText', 'music', 'duration']
};

function newSched() {
  return { at: null, status: 'belum post', attempts: 0, lastError: null, postedAt: null, gaveUp: false };
}

/* Video hasil generate TIDAK disimpan di database. Database ini satu baris JSON
   yang ditulis ulang setiap ada perubahan, jadi blob 5–20 MB akan ikut disalin
   pada tiap ketikan. Isi file ada di data/video/<key produk>/<timestamp>.mp4;
   yang disimpan di state hanya nama file + metadata. */
function newMedia() {
  return { videos: [], pick: '' };
}

function emptyContent(pf) {
  if (pf === 'threads') return { posts: [] };
  return { hook: '', scenes: [], caption: '', hashtags: [], coverText: '', music: '', duration: '' };
}

function newPlatform(pf, plot) {
  return {
    plot: plot || 'p1',
    rev: 1,
    status: 'belum review',
    source: 'template',
    model: '',
    error: '',
    updatedAt: Date.now(),
    ...emptyContent(pf),
    sched: newSched(),
    media: newMedia(),
    history: []
  };
}

function plat(item, pf) {
  if (!item) return newPlatform(pf);
  if (!item.platforms) migrateItem(item);
  if (!item.platforms[pf]) item.platforms[pf] = newPlatform(pf, item.plot);
  return item.platforms[pf];
}

/* sudah pernah digenerate atau belum — dipakai untuk membedakan
   "menunggu review" dari "belum ada isinya sama sekali". */
function hasContent(item, pf) {
  const p = plat(item, pf);
  if (pf === 'threads') return (p.posts || []).length > 0;
  return !!(p.hook || (p.scenes || []).length);
}

/* state lama (satu properti per platform + peta sched) -> item.platforms[pf] */
function migrateItem(it) {
  if (!it || it.platforms) return it;
  const src = it;
  const plot = src.plot || 'p1';
  const out = {};
  PLATFORM_KEYS.forEach((pf) => {
    const old = src[pf] || {};
    const np = newPlatform(pf, plot);
    CONTENT_FIELDS[pf].forEach((f) => {
      if (old[f] !== undefined) np[f] = old[f];
    });
    np.status = old.status || 'belum review';
    np.source = old.source || 'template';
    np.model = old.model || '';
    np.error = old.error || '';
    np.updatedAt = old.updatedAt || Date.now();
    if (src.sched && src.sched[pf]) np.sched = { ...newSched(), ...src.sched[pf] };
    out[pf] = np;
    delete src[pf];
  });
  src.platforms = out;
  delete src.sched;
  return src;
}

/* ---- video hasil generate: akses ke daftar file di state ----
   `media` selalu dinormalkan di sini, bukan di setiap pemakaian, supaya item
   lama (yang belum punya field ini) tidak perlu migrasi khusus. */
function mediaOf(p) {
  if (!p.media || typeof p.media !== 'object') p.media = newMedia();
  const m = p.media;
  if (!Array.isArray(m.videos)) m.videos = [];
  if (typeof m.pick !== 'string') m.pick = '';
  return m;
}

function videosOf(item, pf) {
  return mediaOf(plat(item, pf || 'tiktok')).videos;
}

/* video yang akan dipakai saat posting: yang ditandai "Pakai", kalau tidak ada
   (atau filenya sudah dihapus) pakai unggahan terbaru. */
function pickedVideo(item, pf) {
  const m = mediaOf(plat(item, pf || 'tiktok'));
  return m.videos.find((v) => v.file === m.pick) || m.videos[m.videos.length - 1] || null;
}

function videoUrl(key, file) {
  return '/api/video?key=' + encodeURIComponent(key) + '&file=' + encodeURIComponent(file);
}

/* skor "kaya bahan" — menentukan 3/4/5 post untuk Threads */
function materialScore(item) {
  const d = item.detail;
  if (!d) return 0;
  let s = 0;
  const specs = String(d.specs || '').split('|').map((x) => x.trim())
    .filter((x) => x && !/garansi|mystery|tidak ada|belum ada/i.test(x));
  s += Math.min(4, specs.length);
  const feats = String(d.features || '').split('|').map((x) => x.trim()).filter(Boolean);
  s += Math.min(4, feats.length);
  s += Math.min(3, descBullets(item).length);
  if (sizeNote(item)) s += 1;
  if (shipNote(item)) s += 1;
  return s;
}

function threadParts(item) {
  const p = plat(item, 'threads');
  const plot = p.plot || item.plot || 'p1';
  const sc = materialScore(item);
  let parts = sc >= 10 ? 5 : sc >= 6 ? 4 : 3;
  if (plot === 'p3') parts = Math.min(parts, 3);   // plot matematika bahannya memang pendek
  return parts;
}

/* ---- pengemasan per kalimat ----
   Post tidak boleh terpotong di tengah kalimat. Jadi utas dipecah dulu menjadi
   kalimat utuh (bukan per kata), lalu DP membagi kalimat-kalimat itu menjadi
   3–5 post yang masing-masing 430–500 karakter. Pemotongan hanya terjadi di
   batas kalimat, jadi tidak ada kalimat yang lanjut di post berikutnya.
   Pemisah antar paragraf di dalam post: SATU baris baru (bukan baris kosong). */

/* singkatan yang titiknya bukan akhir kalimat — kalau tidak didaftar,
   "dikirim dari Kab." akan dipotong dan "Tangerang" pindah ke post berikutnya */
const ABBREV = /(?:^|[\s("'])(?:kab|kec|kel|kota|jl|jln|no|bln|tgl|thn|th|dll|dsb|dsj|dst|sdr|sdri|pt|cv|ud|rp|hal|hlm|vol|yth|dgn|dlm|tdk|spt|krn|utk|sbg|jml|uk|cm|mm|kg|gr|ml|lt|pcs|btl|krm|s\.d|a\.n)\.$/i;

/* Pemecah kalimat. Aturannya: titik/kutip hanya jadi batas kalimat kalau
   diikuti spasi DAN bukan bagian dari URL, desimal ("2.1"), atau singkatan.
   Ini yang bikin link afiliasi tidak lagi pecah jadi "https://s. shopee. co. id". */
function splitSentences(text) {
  const s = String(text || '').replace(/[ \t]+/g, ' ').trim();
  if (!s) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    buf += s[i];
    const c = s[i];
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;

    const nxt = s[i + 1];
    if (nxt && !/\s/.test(nxt)) continue;                 // "2.1", "shopee.co.id"
    if (c === '.' && /\d/.test(s[i - 1] || '') && /^\s*\d/.test(s.slice(i + 1, i + 4))) continue;

    /* tanda kutip / kurung tutup yang menempel ikut ke kalimat sebelumnya */
    while (i + 1 < s.length && /["'”’)\]]/.test(s[i + 1])) { buf += s[i + 1]; i++; }

    if (c === '.' && ABBREV.test(buf)) continue;          // "Kab.", "No.", "dll."
    if (!/[a-zA-Z0-9]/.test(buf)) continue;

    out.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/* beats -> daftar kalimat, tiap kalimat tahu apakah dia awal paragraf */
function sentenceUnits(beats) {
  const units = [];
  (beats || []).forEach((b) => {
    const raw = String((b && b.t) || b || '').trim();
    if (!raw) return;
    /* Beat atomic (blok link): yang benar-benar tidak boleh dipecah hanya
       baris URL-nya. Kalimat pengantarnya tetap kalimat biasa supaya bisa
       ditaruh di post mana saja — kalau seluruh blok dianggap satu unit
       (~310 karakter), post terakhir terpaksa menanggung semuanya dan
       pemecahan 3 post jadi tidak mungkin. */
    if (b && b.atomic) {
      raw.split(/\n+/).forEach((line) => {
        const l = line.replace(/\s+/g, ' ').trim();
        if (!l) return;
        if (/^https?:\/\//i.test(l)) { units.push({ text: l, para: true, atomic: true }); return; }
        let first = true;
        splitSentences(l).forEach((s) => { units.push({ text: s, para: first }); first = false; });
      });
      return;
    }
    /* baris kosong maupun baris tunggal sama-sama dianggap batas paragraf */
    raw.split(/\n+/).forEach((para) => {
      const p = para.replace(/\s+/g, ' ').trim();
      if (!p) return;
      let first = true;
      splitSentences(p).forEach((s) => {
        units.push({ text: s, para: first });
        first = false;
      });
    });
  });
  return units;
}

function packSentences(beats, opts) {
  const o = opts || {};
  const MIN = o.minLen || 0;
  const MAX = o.maxLen || 500;
  const minPosts = o.minPosts || 3;

  /* kalimat yang sendirian sudah > MAX tidak mungkin utuh; potong di batas kata
     (kasus langka, hanya untuk kalimat yang memang kelewat panjang).
     Unit atomic (URL) tidak pernah dipotong. */
  const units = [];
  sentenceUnits(beats).forEach((u) => {
    if (u.atomic || u.text.length <= MAX) { units.push(u); return; }
    const words = u.text.split(' ');
    let cur = '';
    let first = true;
    words.forEach((w) => {
      const cand = cur ? cur + ' ' + w : w;
      if (cur && cand.length > MAX) {
        units.push({ text: cur, para: u.para && first });
        first = false;
        cur = w;
      } else cur = cand;
    });
    if (cur) units.push({ text: cur, para: u.para && first });
  });

  const m = units.length;
  if (!m) return [];
  const sep = (k) => (k === 0 ? 0 : 1);          // '\n' atau ' ', dua-duanya 1 karakter
  const pre = new Array(m + 1).fill(0);
  for (let k = 0; k < m; k++) pre[k + 1] = pre[k] + units[k].text.length + sep(k);
  const segLen = (i, j) => pre[j] - pre[i] - sep(i);
  const build = (a, b) => {
    let s = '';
    for (let k = a; k < b; k++) s += (k === a ? '' : (units[k].para ? '\n' : ' ')) + units[k].text;
    return s;
  };

  const run = (p) => {
    const ideal = segLen(0, m) / p;
    const INF = Number.MAX_SAFE_INTEGER;
    const dp = Array.from({ length: p + 1 }, () => new Array(m + 1).fill(INF));
    const from = Array.from({ length: p + 1 }, () => new Array(m + 1).fill(-1));
    dp[0][0] = 0;
    for (let q = 1; q <= p; q++) {
      for (let i = 1; i <= m; i++) {
        for (let j = q - 1; j < i; j++) {
          if (dp[q - 1][j] >= INF) continue;
          const len = segLen(j, i);
          if (len > MAX) continue;
          if (MIN && len < MIN) continue;
          /* potong di tengah paragraf sedikit dihukum, supaya jeda baris
             tetap di tempat yang wajar */
          const cost = dp[q - 1][j] + (len - ideal) * (len - ideal) + (i < m && !units[i].para ? 900 : 0);
          if (cost < dp[q][i]) { dp[q][i] = cost; from[q][i] = j; }
        }
      }
    }
    if (dp[p][m] >= INF) return null;
    const cuts = [];
    let i = m;
    for (let q = p; q >= 1; q--) { const j = from[q][i]; if (j < 0) return null; cuts.unshift([j, i]); i = j; }
    return cuts.map(([a, b]) => build(a, b).trim());
  };

  return run(minPosts) || null;
}

/* kemas utas jadi 3–5 post.
   Jumlah post ditentukan dari PANJANG ISI yang benar-benar dihasilkan model,
   bukan dari perkiraan bahan. Dulu jumlahnya diambil dari threadParts(); kalau
   model menulis 1458 karakter untuk target 3 post, paksaan ke 4 post membuat
   semua post jatuh ke ~360 karakter. Dengan ceil(total/490) isi 1458 jadi 3
   post (~486), dan 1936 jadi 4 post (~484) — semuanya masuk 380–500. */
function packThread(beats, item) {
  const units = sentenceUnits(beats);
  if (!units.length) return [];
  const totalLen = units.reduce((a, u) => a + u.text.length, 0) + (units.length - 1);
  const ideal = Math.max(3, Math.min(5, Math.ceil(totalLen / 490)));

  /* urutan percobaan: jumlah ideal dulu, lalu tetangganya */
  const order = [];
  for (let d = 0; d <= 2; d++) {
    if (ideal - d >= 3) order.push(ideal - d);
    if (d > 0 && ideal + d <= 5) order.push(ideal + d);
  }

  /* pertama: cari susunan yang semua post-nya memenuhi batas bawah yang
     diinginkan (POST_PREF_CHARS) */
  for (const p of order) {
    const posts = packSentences(beats, { minPosts: p, maxPosts: p, minLen: POST_PREF_CHARS, maxLen: POST_MAX_CHARS });
    if (posts && posts.length === p) return posts;
  }
  /* kedua: batas bawah diturunkan ke batas keras, tetap tanpa memotong kalimat */
  for (const p of order) {
    const posts = packSentences(beats, { minPosts: p, maxPosts: p, minLen: POST_MIN_CHARS, maxLen: POST_MAX_CHARS });
    if (posts && posts.length === p) return posts;
  }
  /* ketiga: bebas, lalu rebalancePosts yang merapikan */
  for (const p of order) {
    const posts = packSentences(beats, { minPosts: p, maxPosts: p, minLen: 0, maxLen: POST_MAX_CHARS });
    if (posts && posts.length === p) return posts;
  }
  return [];
}

/* Model kadang menulis jauh lebih panjang dari yang diminta, sehingga
   packThread jatuh ke jalur cadangan dan menghasilkan lebih dari 5 post —
   padahal aturan Threads 3–5 post. Gabungkan post terpendek yang bersebelahan
   sampai jumlahnya masuk aturan; kalau masih lebih, sisanya dipotong rapi. */
function mergeToMax(posts, maxPosts, maxLen) {
  const out = (posts || []).slice();
  while (out.length > maxPosts) {
    let bi = -1, best = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const len = out[i].length + 1 + out[i + 1].length;
      if (len <= maxLen && len < best) { best = len; bi = i; }
    }
    if (bi < 0) break;
    out.splice(bi, 2, out[bi] + '\n' + out[bi + 1]);
  }
  if (out.length > maxPosts) {
    const head = out.slice(0, maxPosts - 1);
    const tail = out.slice(maxPosts - 1).join('\n');
    head.push(cutText(tail, maxLen));
    return head;
  }
  return out;
}

/* Jaring terakhir: kalau ada post yang kurang dari batas bawah, pindahkan
   kalimat pertama post berikutnya ke post itu — selama tidak melewati batas
   atas. Post sumber boleh ikut turun di bawah batas asal masih ada post
   sesudahnya yang bisa mengisi (efek berantai ke belakang); post TERAKHIR
   tidak boleh dikorbankan karena tidak ada lagi sumbernya. */
function rebalancePosts(posts, min, max, floor) {
  const low = floor || min;
  const out = (posts || []).map((s) => String(s).trim()).filter(Boolean);
  for (let i = 0; i < out.length - 1; i++) {
    let guard = 0;
    while (out[i].length < min && guard++ < 8) {
      const next = out[i + 1];
      if (!next) break;
      const m = next.match(/^([\s\S]+?[.!?])\s+/);
      if (!m) break;
      const sentence = m[1].trim();
      if (!sentence) break;
      if (out[i].length + 1 + sentence.length > max) break;
      const rest = next.slice(m[0].length).trim();
      if (!rest) break;
      if (rest.length < low && i + 1 >= out.length - 1) break;
      out[i] = out[i] + ' ' + sentence;
      out[i + 1] = rest;
    }
  }
  return out;
}

/* ---------------- validasi sebelum lolos ----------------
   Gate ini yang mencegah konten setengah jadi masuk antrean jadwal.
   Dijalankan saat user menekan Lolos, bukan saat generate — supaya hasil
   suntingan manual ikut diperiksa dengan aturan yang sama. */

const FORBIDDEN_PHRASES = [
  'Racun Shopee', 'Wajib checkout', 'Sumpah bagus banget', 'Dalam dunia yang serba cepat',
  'Tak dapat dipungkiri', 'Kesimpulannya', 'Mari kita bahas', 'Jangan sampai kehabisan',
  'Bestie', 'Bun'
];

/* Batas panjang post.
   MAX 500 = batas keras Threads. Target yang diminta ke model 440–485.
   Ada DUA batas bawah:
   - POST_PREF_CHARS (380) = yang diusahakan packer. Dengan pemotongan hanya di
     batas kalimat, jendela 380–500 sudah cukup lebar untuk hampir semua isi.
   - POST_MIN_CHARS (250) = batas keras. Kalau panjang kalimatnya bikin susunan
     380–500 tidak mungkin, post boleh turun sampai 250 daripada utasnya
     dianggap gagal padahal isinya baik. */
const POST_MIN_CHARS = 250;
const POST_PREF_CHARS = 380;
const POST_MAX_CHARS = 500;
const POST_TARGET_LO = 440;
const POST_TARGET_HI = 485;

function countEmoji(s) {
  return (String(s).match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).length;
}

/* word-boundary, bukan substring: "Bun" tidak boleh kena "bumbu", "sabun", "kebun" */
function forbiddenHits(text) {
  const out = [];
  FORBIDDEN_PHRASES.forEach((f) => {
    const re = new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(text)) out.push(f);
  });
  return out;
}

function validateContent(item, pf) {
  const p = plat(item, pf);
  const reasons = [];

  if (pf === 'threads') {
    const posts = p.posts || [];
    if (posts.length < 3 || posts.length > 5) reasons.push('jumlah post ' + posts.length + ', harus 3–5');
    posts.forEach((t, i) => {
      if (t.length < POST_MIN_CHARS) reasons.push('post ' + (i + 1) + ' cuma ' + t.length + ' karakter (min ' + POST_MIN_CHARS + ')');
      if (t.length > POST_MAX_CHARS) reasons.push('post ' + (i + 1) + ' ' + t.length + ' karakter (maks ' + POST_MAX_CHARS + ')');
      if (/#\w/.test(t)) reasons.push('post ' + (i + 1) + ' memuat hashtag');
    });
    if (/https?:\/\//.test(posts.slice(0, -1).join(' '))) reasons.push('link ada di post selain yang terakhir');
    const last = posts[posts.length - 1] || '';
    if (item.affiliateUrl && last.indexOf(item.affiliateUrl) < 0) reasons.push('post terakhir belum memuat link afiliasi');
    if (countEmoji(posts.join(' ')) > 2) reasons.push('emoji lebih dari 2 di satu utas');
    const hits = forbiddenHits(posts.join('\n'));
    if (hits.length) reasons.push('frasa terlarang: ' + hits.join(', '));
  } else {
    if (!p.hook) reasons.push('hook masih kosong');
    if ((p.scenes || []).length < 3) reasons.push('scene kurang dari 3');
    if ((p.caption || '').length > 2200) reasons.push('caption lebih dari 2200 karakter');
    const hits = forbiddenHits([p.hook, p.caption].join('\n'));
    if (hits.length) reasons.push('frasa terlarang: ' + hits.join(', '));
  }

  return { ok: reasons.length === 0, reasons };
}

/* ---------------- seed data ---------------- */
const SEED_CSV = `ID Produk,Nama Produk,Harga,Penjualan,Nama Toko,Komisi hingga,Komisi,Link Produk,Link Komisi Ekstra
41678605428,SEPATU SAFETY BOOTS PRIA CAT ARGON UJUNG BESI SEPATU KERJA PROYEK BISA BAYAR DI TEMPAT,"84,5RB",1RB+,Sepatu.Boots.Pria.,5%,Rp4.225,https://shopee.co.id/product/39404232/41678605428,https://s.shopee.co.id/1LgXwboEXA
41561442154,Botol Tumbler 900ml Stainless Steel Tahan Panas Dingin,"64,0RB",10RB+,HLF24oke,10%,Rp6.399,https://shopee.co.id/product/607593297/41561442154,https://s.shopee.co.id/1Vzy8unbCD
46964793009,( Bonus Topi ) Sweater Hoodie G3r Kr Text Gold Jaket Hoodie Pria Wanita Tebal dan Nyaman Bahan Katun Pleece Premium,"69,6RB",156,DISTRO_ID,10%,Rp6.962,https://shopee.co.id/product/742479216/46964793009,https://s.shopee.co.id/1gJOLDmxrG
40622871786,Celana Jeans Cutbray Wanita Streach Loose Kekinian-Highwaist Cutbray Jeans Wanita Premium Quality,"150,0RB",10RB+,Exclusive Jeans,10%,Rp15.000,https://shopee.co.id/product/1645771906/40622871786,https://s.shopee.co.id/1qcoXWmKWJ
50661100069,COD Sandal Pria Wanita Kekinian Empuk Sendal Laki Jelly Rumah Sepatu Sendal Slop Cowo  Sandal Lembut,"34,5RB",10RB+,Kumada,10%,Rp3.454,https://shopee.co.id/product/1106667928/50661100069,https://s.shopee.co.id/20wEjplhBM
41463430148,Sepatu Pria Sneakers Sport Running Casual Cocok Buat Nongkrong Jogging dan Jalan Santaii,"125,0RB",668,AS.STORS.99,10%,Rp12.500,https://shopee.co.id/product/1537007269/41463430148,https://s.shopee.co.id/2BFew8l3qP
27069197841,Sepatu Sneakers Import Perempuan Laki-laki Sepatu Running Perempuan Laki-laki Sepatu Sekolah Perempuan Laki-laki Ukuran 38-44,"85,0RB",2RB+,SNEAKERSKI,20%,Rp17.000,https://shopee.co.id/product/1099311071/27069197841,https://s.shopee.co.id/2LZ58RkQVS
41620728444,Sepatu Sneakers Sport Running casual ZOOM series pria & wanita Terbaru,"29,9RB",2RB+,RumaishaKids,5%,Rp1.495,https://shopee.co.id/product/798699454/41620728444,https://s.shopee.co.id/2VsVKkjnAV
28425599035,Case Airpods Gen 1 2 3 4 Pro / Pro 2,"13,5RB",10RB+,PODCASE INDONESIA,20%,Rp2.706,https://shopee.co.id/product/1471355665/28425599035,https://s.shopee.co.id/1BAM9tJF2
23718614219,SEPATU PRIA SNEAKERS PRIA SEPATU IMPORT SEPATU TALI FASHION KASUAL SNEAKERS(TANPA KOTAK),"104,8RB",10RB+,LKB.Grosir Official Store,7%,Rp7.333,https://shopee.co.id/product/799175511/23718614219,https://s.shopee.co.id/BUaYSsfu5`;

const AI_PRESETS = {
  gemini:     { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
  'gemini-oai': { label: 'Google Gemini (OpenAI-compatible)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  openai:     { label: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'] },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', models: ['google/gemini-2.5-flash', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'] },
  groq:       { label: 'Groq', base: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  deepseek:   { label: 'DeepSeek', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
  custom:     { label: 'Custom / proxy', base: '', models: [] }
};

/* Satu konfigurasi untuk semua teks. Dulu tiap platform punya kartu sendiri
   padahal modelnya sama — yang beda cuma prompt-nya. Sekarang cukup satu,
   dan tidak ada lagi toggle "pakai LLM": generate selalu lewat LLM. */
const AI_DEFAULT = { provider: 'gemini', model: 'gemini-2.5-flash', key: '', baseUrl: '', temp: 0.9 };

/* ---------------- override LLM di komputer ini ----------------
   Kenapa ada: jalur VPS -> tunnel -> laptop bisa putus, dan permintaan LLM
   adalah yang paling lama menggantung di jalur itu. Kalau aplikasi dibuka dari
   laptop yang menjalankan gateway, browser bisa memanggil gateway lewat
   127.0.0.1 langsung — tidak melewati VPS sama sekali.

   Disimpan di localStorage, BUKAN di database: kunci ini milik komputer ini.
   Kalau ditulis ke state, ia akan terkirim ke server dan (sebelum redaksi)
   terbaca pengunjung lain. Setelan ini juga tidak pernah menimpa data server —
   ia hanya lapisan pertama di aiCfg(). */
const LS_LLM = 'afiliasi.llm.v1';
const LS_SKIP = 'afiliasi.llm.setup-skip';

function lsLlmGet() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_LLM) || 'null');
    return j && typeof j === 'object' ? j : null;
  } catch (e) { return null; }
}

function lsLlmSet(v) {
  try {
    if (v) localStorage.setItem(LS_LLM, JSON.stringify(v));
    else localStorage.removeItem(LS_LLM);
  } catch (e) { /* mode privat / storage penuh: jalan terus tanpa simpan */ }
}

function lsLlmActive() {
  const j = lsLlmGet();
  return !!(j && j.enabled && String(j.baseUrl || '').trim());
}

const DEFAULT_SETTINGS = {
  mode: 'simulasi',
  failRate: 20,
  maxAttempts: 3,
  retryDelay: 2,
  /* zona waktu AUDIENS: semua jam di bawah dibaca di zona ini, bukan jam perangkat */
  tzAudience: 'Asia/Jakarta',
  /* jam puncak audiens. [0] = jendela utama, [1] = jendela kedua */
  hourThreads: 12,
  hourThreads2: 9,
  hourTiktok: 19,
  hourTiktok2: 14,
  gapMin: 45
};

/* ---------------- store ---------------- */
/* Tidak ada key localStorage lagi. Data tinggal di data/affiliate.db.
   Key lama (affiliate-studio.v5/v6) sengaja tidak disentuh: isinya sudah
   tidak dibaca dan tidak akan pernah ditulis lagi oleh aplikasi ini. */

/* Dulu detail produk diambil dari detail.js (file statis hasil ekstraksi).
   File itu tidak pernah dipangkas saat produk dihapus, jadi produk yang baru
   diimpor bisa "mewarisi" detail milik produk lama yang sudah dihapus — angka
   di UI jadi tidak sinkron dengan database. Sekarang detail hanya masuk lewat
   database per item: hasil ekstraksi (mergeDetails) atau import JSON manual. */

/* Katalog = fakta produk yang boleh berubah tiap batch (harga, terjual, komisi, link).
   Dipisah dari pipeline (konten + jadwal) yang append-only. */
function katalogOf(r) {
  const cols = (r || []).map((x) => String(x == null ? '' : x).trim());
  const [id, name, price, sold, shop, commRate, comm, productUrl, affUrl] = cols;
  return {
    productId: id || '',
    name: name || 'Tanpa nama',
    priceText: price || '0',
    priceNum: parsePrice(price),
    soldText: sold || '0',
    soldNum: parseSold(sold),
    shop: shop || 'Toko',
    commRate: commRate || '',
    commText: comm || '',
    commNum: parsePrice(String(comm || '').replace(/rp/i, '')),
    productUrl: productUrl || '',
    affiliateUrl: affUrl || productUrl || ''
  };
}

function makeItem(r, plot) {
  const k = katalogOf(r);
  const item = {
    key: 'p' + (k.productId || Math.random().toString(36).slice(2, 8)),
    ...k,
    category: detectCat(k.name),
    plot: plot || 'p1',
    detail: null,
    detailStatus: 'pending',
    batchId: todayKey(),
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    priceDrift: null,
    variant: 0,
    archived: false,
    platforms: {
      threads: newPlatform('threads', plot || 'p1'),
      tiktok: newPlatform('tiktok', plot || 'p1')
    }
  };
  /* Tidak ada draf otomatis di sini. Konten dibuat di tahap Generate, setelah
     bahan dari detail produk ada. Import hanya mengisi katalog. */
  return item;
}

/* ---------- import bertahap: katalog di-upsert, pipeline tidak disentuh ---------- */

/* "beku" = konten sudah disetujui atau sudah tayang. Katalognya tetap boleh
   diperbarui, tapi konten & jadwalnya tidak boleh berubah otomatis. */
function isFrozen(it) {
  return PLATFORM_KEYS.some((pf) => {
    const p = plat(it, pf);
    return p.status === 'lolos' || p.sched.status === 'berhasil posting';
  });
}

/* bandingkan CSV baru dengan yang sudah ada, tanpa mengubah apa pun */
function planImport(rows) {
  const plan = { batch: todayKey(), now: Date.now(), added: [], updated: [], seen: new Set(), dupes: 0, invalid: 0 };
  rows.forEach((r) => {
    const k = katalogOf(r);
    if (!k.productId || !k.name || k.name === 'Tanpa nama') { plan.invalid++; return; }
    const key = 'p' + k.productId;
    if (plan.seen.has(key)) { plan.dupes++; return; }
    plan.seen.add(key);
    const it = S.items.find((x) => x.key === key);
    if (!it) { plan.added.push(k); return; }
    const changes = [];
    if (it.name !== k.name) changes.push('nama');
    if (it.priceText !== k.priceText) changes.push('harga');
    if (it.soldText !== k.soldText) changes.push('terjual');
    if (it.commText !== k.commText) changes.push('komisi');
    if (it.affiliateUrl !== k.affiliateUrl) changes.push('link');
    plan.updated.push({ k, changes, item: it });
  });
  return plan;
}

function applyImport(plan) {
  const now = plan.now || Date.now();
  let added = 0, touched = 0, changed = 0, revived = 0, regenerated = 0;
  plan.added.forEach((k) => {
    const it = makeItem([k.productId, k.name, k.priceText, k.soldText, k.shop, k.commRate, k.commText, k.productUrl, k.affiliateUrl], nextPlot());
    it.batchId = plan.batch;
    S.items.unshift(it);
    added++;
  });
  plan.updated.forEach(({ k, changes, item }) => {
    const oldPrice = item.priceText;
    Object.assign(item, k);
    item.lastSeenAt = now;
    /* tidak ada lagi "aktif lagi": produk yang dihapus sudah benar-benar hilang
       dari S.items, jadi import dengan ID sama masuk jalur "added" sebagai item baru. */
    touched++;
    if (changes.length) changed++;
    if (oldPrice !== k.priceText) {
      item.priceDrift = { from: oldPrice, to: k.priceText, at: now };
      /* konten yang belum tayang aman diperbarui; yang sudah lolos/posted dibiarkan.
         Yang belum punya draf tidak dipaksa dibuat — itu tetap di tahap Generate. */
      /* Harga berubah → konten lama jadi tidak akurat. Dulu langsung ditulis
         ulang pakai template; sekarang cukup ditandai regenerate supaya tidak
         ada konten template yang menimpa hasil LLM tanpa sepengetahuan user. */
      if (!isFrozen(item) && hasContent(item, 'threads')) {
        plat(item, 'threads').status = 'regenerate';
        plat(item, 'tiktok').status = 'regenerate';
        regenerated++;
      }
    }
  });
  S.meta = S.meta || {};
  S.meta.lastImportAt = now;
  S.meta.lastImportBatch = plan.batch;
  S.meta.lastImportAdded = added;
  S.meta.lastImportTouched = touched;
  syncMeta();     // hitung ulang dari produk yang benar-benar ada
  return { added, touched, changed, revived, regenerated, dupes: plan.dupes };
}

let _pendingImport = null;

/* gabungkan hasil extract_batch.py ke item yang cocok (berdasarkan product_id) */
function mergeDetails(obj) {
  const res = { ok: 0, bad: 0, regen: 0, unknown: 0 };
  if (!obj || typeof obj !== 'object') return res;
  Object.keys(obj).forEach((pid) => {
    const it = S.items.find((x) => x.productId === String(pid));
    if (!it) { res.unknown++; return; }
    const d = obj[pid] || {};
    if (d.status === 'success') {
      it.detail = d;
      it.detailStatus = 'ok';
      res.ok++;
      /* Tidak lagi regenerate otomatis. Detail yang baru masuk membuat produk
         SIAP digenerate — tapi pembuatannya tetap keputusan pengguna (tahap
         Generate), bukan efek samping import. */
    } else {
      it.detailStatus = 'gagal';
      res.bad++;
    }
  });
  return res;
}

/* pengaturan dari file pengaturan.js (dimuat sebelum app.js) */
const SEED = (typeof window !== 'undefined' && window.SAVED_SETTINGS) || null;

function applySeed(seed, hard) {
  if (!seed || typeof seed !== 'object') return false;
  if (seed.settings) S.settings = { ...DEFAULT_SETTINGS, ...seed.settings };
  if (seed.ai) {
    const A = S.ai = S.ai || {};
    /* file seed lama menyimpan {threads, tiktok}; ambil yang threads karena
       itu konfigurasi teks yang dulu dipakai. */
    const v = seed.ai.text || seed.ai.threads || null;
    if (v) {
      A.text = { ...AI_DEFAULT, ...v };
      delete A.text.on;
      delete A.threads; delete A.tiktok;
    }
  }
  // jangan hapus editan bank kalimat hanya karena file seed tidak memuatnya
  if (seed.copy && (hard || Object.keys(seed.copy).length)) S.copy = seed.copy;
  S.seedStamp = seed.savedAt || null;
  return true;
}

function initialState() {
  /* mulai dari kosong — 10 produk contoh tetap tersedia lewat tombol
     "Isi contoh 10 produk" (aksi import-sample) di tab Data Produk. */
  return {
    items: [],
    riwayat: [],
    settings: { ...DEFAULT_SETTINGS },
    copy: {},
    ai: { text: { ...AI_DEFAULT } },
    used: usedDump(),
    meta: { lastImportAt: null, lastImportBatch: todayKey(), lastImportAdded: 0, lastImportTouched: 0 },
    logs: [{ ts: Date.now(), kind: 'info', msg: 'Aplikasi siap — belum ada produk. Import CSV di tab Data Produk.' }],
    ui: { view: 'dashboard', reviewTab: 'threads', reviewFilter: 'semua', schedFilter: 'semua', running: false, copyPlot: 'p1', copyCat: 'safety' }
  };
}

/* pulihkan state dari file backup (atau dari objek mentah hasil ekspor lama).
   Dipakai juga sebagai jalur pindah-origin: backup di satu origin, pulihkan di origin lain. */
let _catMigrasi = 0;   // berapa kategori yang diperbaiki saat memuat

function restoreState(obj) {
  _catMigrasi = 0;
  const src = (obj && obj.state) ? obj.state : obj;
  if (!src || !Array.isArray(src.items)) throw new Error('File itu tidak berisi daftar produk');

  const base = initialState();
  const next = {
    items: src.items,
    riwayat: Array.isArray(src.riwayat) ? src.riwayat : [],
    settings: { ...DEFAULT_SETTINGS, ...(src.settings || {}) },
    copy: src.copy || {},
    ai: {
      /* bentuk lama {threads, tiktok} → satu config teks, pakai isi threads */
      text: { ...AI_DEFAULT, ...(((src.ai || {}).text) || ((src.ai || {}).threads) || {}), on: undefined }
    },
    used: src.used || {},
    meta: src.meta || {},
    logs: Array.isArray(src.logs) ? src.logs : [],
    ui: { ...base.ui, ...(src.ui || {}), running: false },
    seedStamp: src.seedStamp || null,
    schemaVersion: SCHEMA_VERSION
  };

  next.items.forEach((i) => {
    migrateItem(i);
    if (i.batchId === undefined) i.batchId = next.meta.lastImportBatch || todayKey();
    if (i.firstSeenAt === undefined) i.firstSeenAt = plat(i, 'threads').updatedAt || Date.now();
    if (i.lastSeenAt === undefined) i.lastSeenAt = next.meta.lastImportAt || i.firstSeenAt;
    if (i.detailStatus === undefined) i.detailStatus = i.detail ? 'ok' : 'pending';
    if (i.priceDrift === undefined) i.priceDrift = null;
    if (!i.platforms) migrateItem(i);
    /* Kategori lama ditebak dengan daftar kata kunci yang lebih sempit, jadi
       banyak produk telanjur "generic" (label: Produk) atau salah tebak.
       Sekali di sini: hitung ulang dari nama. Dilewati kalau kategori pernah
       ditetapkan manual (catManual), supaya pilihan pengguna tidak ditimpa. */
    if (!i.catManual) {
      const c = detectCat(i.name);
      if (c !== i.category) { i.category = c; _catMigrasi++; }
    }
  });

  /* Sisa model lama: dulu "hapus" hanya menandai archived, jadi produknya masih
     mengendap di database dan angkanya masih ikut terhitung. Sekarang hapus itu
     permanen — bersihkan sekali di sini. Postingan yang sudah berhasil tayang
     tetap diselamatkan ke riwayat, sisanya (draf + jadwal) ikut hilang. */
  const arsip = next.items.filter((i) => i.archived);
  if (arsip.length) {
    let tayang = 0;
    arsip.forEach((i) => { tayang += simpanRiwayatTayang(i, next); });
    next.items = next.items.filter((i) => !i.archived);
    next.logs = [
      { ts: Date.now(), kind: 'info', msg: `${arsip.length} produk sisa arsip dibersihkan permanen${tayang ? ` · ${tayang} postingan tayang disimpan` : ''}` },
      ...(next.logs || [])
    ];
  }
  syncMetaOf(next);
  return next;
}

/* state awal di memori. Isinya belum tentu yang dipakai: begitu server
   menjawab, isi database menggantikan seluruh objek ini (lihat initStore). */
let S;
let SEED_NOTE = '';
try {
  S = restoreState(initialState());
  /* pengaturan.js hanya jadi nilai awal. Kalau database sudah punya state,
     versi database yang menang — jangan sampai file lama menimpa editan. */
  if (SEED) { applySeed(SEED); SEED_NOTE = 'Pengaturan awal dimuat dari pengaturan.js'; }
} catch (e) {
  S = initialState();
  if (SEED) { applySeed(SEED); SEED_NOTE = 'Pengaturan awal dimuat dari pengaturan.js'; }
}

usedLoad(S.used);

/* ---------------- penyimpanan ----------------
   Satu sumber kebenaran: data/affiliate.db, ditulis lewat server.py.

   Tidak ada salinan di localStorage. Itu keputusan, bukan kelalaian:
   - salinan lokal selalu bisa menyimpang dari database, dan penyimpangan
     itulah yang bikin data "hilang" tanpa suara;
   - saat nanti pindah ke Postgres di cloud, yang berubah hanya isi dua
     fungsi di bawah (loadState / saveState), bukan logika aplikasi.

   Kalau server tidak terjangkau, aplikasi berhenti di layar "database tidak
   terhubung". Lebih baik menolak jalan daripada menerima input yang tidak
   akan pernah tersimpan. */

const SERVER_ORIGIN = 'http://127.0.0.1:8787';

/* Di mana API berada.
   Default: relatif — benar selama halaman disajikan oleh server.py itu sendiri,
   termasuk kalau portnya diganti (mis. server uji di 8788).
   Kalau relatif gagal (mis. halaman dibuka dari preview panel di port lain),
   initStore mencoba alamat absolut ke server standar. */
let API = '/api';
const SERVED_HTTP = typeof location !== 'undefined' && /^https?:$/.test(String(location.protocol));

const STORE = {
  mode: 'connecting',   // 'connecting' | 'file' | 'server' | 'offline'
  ready: false,         // load awal dari database sudah selesai?
  rev: 0,               // revisi terakhir di database
  ok: true,             // tulisan terakhir berhasil?
  err: '',              // pesan kegagalan terakhir
  serverOk: true,
  serverErr: '',
  bytes: 0,
  savedAt: null,
  pending: false,       // ada perubahan yang belum terkirim?
  conflict: 0           // revisi lain yang menang; >0 berarti tulis ditahan
};

/* halaman dibuka langsung dari folder, bukan dari server */
function openedFromFile() {
  return typeof location !== 'undefined' && String(location.protocol) === 'file:';
}

/* ---- adapter: satu-satunya tempat yang tahu bentuk backend ---- */

/* baca seluruh state dari database. null = database masih kosong. */
async function loadState() {
  const r = await fetch(API + '/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j && j.state && Array.isArray(j.state.items) ? j : null;
}

/* tulis seluruh state. mengembalikan {rev, bytes}. */
async function saveState(state, baseRev) {
  const r = await fetch(API + '/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, baseRev })
  });
  if (r.status === 409) {
    const j = await r.json().catch(() => ({}));
    const err = new Error('konflik');
    err.conflict = true;
    err.rev = j.rev || 0;
    throw err;
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { rev: j.rev || 0, bytes: j.bytes || 0, savedAt: Date.now() };
}

/* ---- antrean tulis ---- */

let _pushTimer = null;
let _pushing = false;
let _dirty = false;

/* dipanggil setiap ada perubahan. Tidak menyimpan apa pun secara lokal —
   hanya menandai bahwa database perlu diperbarui. */
function save() {
  if (STORE.mode === 'offline') {
    STORE.ok = false;
    STORE.err = 'database tidak terhubung';
    return;
  }
  S.used = usedDump();          // rotasi kalimat ikut tersimpan
  STORE.pending = true;
  queuePush();
}

function queuePush() {
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushRemote, 400);
}

async function pushRemote() {
  if (STORE.mode !== 'server') return false;
  if (STORE.conflict) return false;          // tunggu pengguna memilih arah
  if (_pushing) { _dirty = true; return false; }
  _pushing = true;
  try {
    const j = await saveState(S, STORE.rev);
    STORE.ok = true;
    STORE.err = '';
    STORE.serverOk = true;
    STORE.serverErr = '';
    STORE.rev = j.rev || STORE.rev;
    STORE.bytes = j.bytes || STORE.bytes;
    STORE.savedAt = j.savedAt;
    return true;
  } catch (e) {
    STORE.ok = false;
    STORE.serverOk = false;
    if (e && e.conflict) {
      STORE.conflict = e.rev || 0;
      STORE.err = `database sudah berubah (revisi ${e.rev}). Tab atau proses lain menulis lebih dulu.`;
      STORE.serverErr = STORE.err;
    } else {
      STORE.err = String((e && e.message) || e);
      STORE.serverErr = STORE.err;
    }
    return false;
  } finally {
    _pushing = false;
    const again = _dirty && !STORE.conflict;
    _dirty = false;
    STORE.pending = again;
    renderNav();
    if (again) queuePush();
  }
}

/* dipanggil sekali saat start. Tidak ada fallback: kalau database tidak
   terjangkau, mode jadi 'offline' dan UI dikunci. */
async function initStore() {
  /* Dibuka lewat file://: browser memblokir semua request ke 127.0.0.1, jadi
     tidak ada gunanya mencoba. Tampilkan layar pembuka — satu klik ke alamat
     server yang benar, bukan pesan error. */
  if (openedFromFile()) {
    STORE.mode = 'file';
    STORE.ready = true;
    render();
    return;
  }
  try {
    let j;
    try {
      j = await loadState();
    } catch (e) {
      /* relatif gagal — halaman mungkin disajikan proxy/preview di port lain.
         Coba alamat absolut ke server standar sebelum menyerah. */
      if (SERVED_HTTP && API !== SERVER_ORIGIN + '/api') {
        API = SERVER_ORIGIN + '/api';
        j = await loadState();
      } else {
        throw e;
      }
    }
    STORE.mode = 'server';
    STORE.serverOk = true;
    STORE.ok = true;
    STORE.conflict = 0;

    if (j) {
      S = restoreState(j.state);
      usedLoad(S.used);
      STORE.rev = j.rev || 0;
      STORE.bytes = j.bytes || 0;
      STORE.savedAt = j.updatedAt || Date.now();
      /* restoreState membuang sisa arsip model lama. Kalau jumlahnya berubah,
         tulis balik supaya database tidak menyimpan baris yang sudah tidak
         dipakai UI — kalau tidak, angka hantu bisa muncul lagi di sesi lain. */
      if ((j.state.items || []).length !== S.items.length || _catMigrasi) save();
    } else {
      /* database kosong: state awal (tanpa produk) jadi revisi pertama */
      STORE.rev = 0;
      await pushRemote();
    }
    STORE.ready = true;
    render();
    /* Daftar aset dibaca dari server, bukan dari manifest.js yang di-cache
       browser — supaya media hasil ekstraksi langsung kelihatan. */
    refreshAssets().then((ok) => { if (ok) render(); });
    /* file video yang sudah ada di disk tapi belum tercatat di state diadopsi
       di sini — sekali per muat halaman. */
    reconcileVideos();
  } catch (e) {
    STORE.mode = 'offline';
    STORE.ready = true;
    STORE.err = String((e && e.message) || e);
    render();
  }
}

/* sehat = tempat data itu benar-benar tersimpan sedang bisa ditulis */
function storageHealthy() {
  return STORE.mode === 'server' && STORE.serverOk;
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  return n > 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

/* origin hanya dipakai sebagai metadata di file backup, bukan penentu data */
function originLabel() {
  if (typeof location === 'undefined') return '-';
  if (location.protocol === 'file:') return 'file:// (dibuka langsung dari folder)';
  return location.origin;
}

/* baris status di sidebar — satu-satunya tempat yang selalu kelihatan */
function storageLine() {
  if (STORE.mode === 'file') {
    return `<div style="margin-top:8px;line-height:1.5" class="tiny muted">
      <b>Belum di server</b><br>
      <span style="opacity:.8">buka ${SERVER_ORIGIN}/</span>
    </div>`;
  }
  if (STORE.mode === 'connecting') {
    return `<div style="margin-top:8px;line-height:1.5" class="tiny muted">
      <b>Menghubungkan…</b><br><span style="opacity:.8">${SERVER_ORIGIN}</span>
    </div>`;
  }
  if (STORE.mode === 'offline') {
    return `<div style="margin-top:8px;line-height:1.5;color:var(--danger)">
      <b>Database tidak terhubung</b><br><span class="tiny">Jalankan <code>mulai.bat</code>, lalu buka <code>${SERVER_ORIGIN}/</code>.</span>
    </div>`;
  }
  if (!STORE.serverOk) {
    return `<div style="margin-top:8px;line-height:1.5;color:var(--danger)">
      <b>Server tidak merespons</b><br><span class="tiny">${esc(STORE.serverErr || 'gagal menyimpan')}</span>
    </div>`;
  }
  return `<div style="margin-top:8px;line-height:1.6" class="tiny muted" title="Disimpan oleh server.py ke data/affiliate.db. Semua browser di mesin ini membaca data yang sama.">
    <b style="color:var(--ok)">SQLite · server</b> · rev ${STORE.rev}<br>
    ${STORE.pending ? '<span style="color:var(--warn)">menyimpan…</span>' : (STORE.savedAt ? fmtTime(STORE.savedAt) : '—')} · ${fmtBytes(STORE.bytes)}
    <br><span style="opacity:.7">build ${UI_BUILD}</span>
  </div>`;
}

function log(kind, msg) {
  S.logs.unshift({ ts: Date.now(), kind, msg });
  if (S.logs.length > 120) S.logs.length = 120;
}

function activeItems() { return S.items.filter((i) => !i.archived); }

/* ---------------- hapus permanen + riwayat tayang ----------------
   Aturan: hapus itu menyeluruh — katalog, draf, dan jadwal ikut hilang.
   Satu pengecualian: postingan yang statusnya "berhasil posting" sudah
   tayang di dunia nyata, jadi jejaknya disimpan di S.riwayat. Import ulang
   dengan productId yang sama tidak menghidupkan apa pun — itu item baru. */

function simpanRiwayatTayang(it, target) {
  const t = target || S;
  if (!Array.isArray(t.riwayat)) t.riwayat = [];
  const posted = {};
  PLATFORM_KEYS.forEach((pf) => {
    const p = plat(it, pf);
    if (!p.sched || p.sched.status !== 'berhasil posting') return;
    const rec = { plot: p.plot, rev: p.rev, sched: { ...p.sched } };
    CONTENT_FIELDS[pf].forEach((f) => {
      const v = p[f];
      rec[f] = v === undefined ? JSON.parse(JSON.stringify(emptyContent(pf)[f])) : JSON.parse(JSON.stringify(v));
    });
    posted[pf] = rec;
  });
  const n = Object.keys(posted).length;
  if (!n) return 0;
  t.riwayat.unshift({
    key: it.key, productId: it.productId, name: it.name, shop: it.shop,
    affiliateUrl: it.affiliateUrl, at: Date.now(), platforms: posted
  });
  if (t.riwayat.length > 200) t.riwayat.length = 200;
  return n;
}

/* angka di kartu Status batch selalu dihitung ulang dari produk yang benar-benar
   ada. Tidak ada counter yang bisa tertinggal setelah produk dihapus. */
function syncMetaOf(st) {
  if (!st) return;
  st.meta = st.meta || {};
  const act = st.items.filter((i) => !i.archived);
  if (!act.length) {
    st.meta.lastImportBatch = null;
    st.meta.lastImportAt = null;
    st.meta.lastImportAdded = 0;
    st.meta.lastImportTouched = 0;
    return;
  }
  const b = st.meta.lastImportBatch;
  if (!b) return;
  const at = st.meta.lastImportAt || 0;
  st.meta.lastImportAdded = act.filter((i) => i.batchId === b).length;
  st.meta.lastImportTouched = act.filter((i) => i.batchId !== b && i.lastSeenAt === at).length;
}

function syncMeta() { syncMetaOf(S); }

/* buang satu item secara permanen, postingan tayangnya diselamatkan dulu */
function hapusItemPermanen(it) {
  if (!it) return 0;
  const n = simpanRiwayatTayang(it);
  S.items = S.items.filter((x) => x.key !== it.key);
  return n;
}

/* ---------------- scheduling helpers ---------------- */
const PRODUCT_COOLDOWN_DAYS = 14;

/* kapan produk ini terakhir tayang, lintas platform */
function lastPostedAt(item) {
  return PLATFORM_KEYS.reduce((max, pf) => {
    const t = plat(item, pf).sched.postedAt || 0;
    return t > max ? t : max;
  }, 0);
}

/* ---------- jadwal: jam prime di zona waktu audiens ----------
   Sumber yang dipakai (2026):
   - Metricool, 2.314.756 post / 92.000 akun: puncak tayangan 18.00–20.00,
     20.00 jam terbaik hampir tiap hari, Sabtu puncaknya lebih awal (18.00),
     Minggu paling kuat, 02.00–04.00 nyaris mati.
   - HopperHQ (membandingkan Buffer 7,1 juta post dan Sprout Social ~2 miliar
     engagement): jam dihitung dalam ZONA WAKTU AUDIENS, dan yang dianjurkan
     adalah mengunggah 30–60 menit SEBELUM jendela puncak — engagement jam
     pertama yang menentukan seberapa jauh video didorong.
   - SocialPilot (700.000 post TikTok / 50.000 akun; 50.000 akun Threads):
     TikTok 3 jendela/hari dengan 18–21 paling kuat, Threads 3 jendela dengan
     puncak justru di jam makan siang, bukan malam.

   Jadi jam di Pengaturan adalah JAM PUNCAK AUDIENS, dan yang dipakai untuk
   tayang adalah 30 menit sebelumnya (TikTok). Threads tidak digeser — tidak
   ada studi Threads sekelas itu, lebih baik jujur tidak punya angka.

   Dua jendela per platform per hari (MAX_PER_DAY): jendela [0] utama,
   jendela [1] pendukung. Semuanya dihitung di tzAudience, bukan jam perangkat. */
const LEAD_MIN = { tiktok: 30, threads: 0 };
const MAX_PER_DAY = 2;              // dua jendela per platform per hari

/* daftar jam puncak per platform, urut dari yang terkuat */
function slotHours(pf) {
  const a = pf === 'threads' ? S.settings.hourThreads : S.settings.hourTiktok;
  const b = pf === 'threads' ? S.settings.hourThreads2 : S.settings.hourTiktok2;
  const list = [Number(a), Number(b)].filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [12];
}

/* Sabtu TikTok lebih awal 1 jam (pola pemakaian akhir pekan) */
function shiftHour(pf, wd, h) {
  const x = (pf === 'tiktok' && wd === 6) ? h - 1 : h;
  return (x + 24) % 24;            // 00.00 digeser jadi 23.00, bukan -1
}

/* slot tayang ke-`which` pada hari ke-`offsetDays`, dihitung di kalender audiens */
function primeSlotFor(pf, offsetDays, which) {
  const tz = tzId();
  const now = tzParts(Date.now(), tz);
  const day = new Date(Date.UTC(now.y, now.m - 1, now.d + (offsetDays || 0)));
  const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
  const wd = day.getUTCDay();
  const hours = slotHours(pf);
  const base = hours[which] != null ? hours[which] : hours[0];
  const peak = shiftHour(pf, wd, base);
  return zonedToUtc(y, m, d, peak, 0, tz) - (LEAD_MIN[pf] || 0) * 60000;
}

/* keterangan kecil di tabel: kenapa jam ini dipilih */
function primeNote(pf, ts) {
  if (!ts) return '';
  const tz = tzId();
  const p = tzParts(ts, tz);
  const hours = slotHours(pf);
  const lead = LEAD_MIN[pf] || 0;
  /* dua hari: slot bisa jatuh di hari sebelumnya kalau puncaknya lewat tengah malam */
  for (const dd of [0, 1]) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + dd));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const wd = day.getUTCDay();
    for (let w = 0; w < hours.length; w++) {
      const peak = shiftHour(pf, wd, hours[w]);
      const slot = zonedToUtc(y, m, d, peak, 0, tz) - lead * 60000;
      if (slot !== ts) continue;
      const hh = String(peak).padStart(2, '0');
      if (!lead) return `prime · puncak ${hh}.00 ${tzLabel()}`;
      return `prime · puncak ${hh}.00 ${tzLabel()} · tayang ${pad(p.h)}.${pad(p.mi)}`;
    }
  }
  return '';
}

function suggestSlot(pf, item) {
  const now = Date.now();
  const lead = 30 * 60000;                 // jangan menjadwalkan yang sudah lewat
  const takenMin = new Set();
  const dayCount = new Map();              // kunci tanggal AUDIENS -> jumlah tayang
  activeItems().forEach((i) => {
    const t = plat(i, pf).sched.at;
    if (!t) return;
    takenMin.add(Math.floor(t / 60000));
    const k = tzDayKey(t);
    dayCount.set(k, (dayCount.get(k) || 0) + 1);
  });
  const last = item ? lastPostedAt(item) : 0;
  const earliest = last ? last + PRODUCT_COOLDOWN_DAYS * 864e5 : 0;
  const hours = slotHours(pf);

  for (let d = 0; d < 365; d++) {
    for (let w = 0; w < hours.length; w++) {
      const ms = primeSlotFor(pf, d, w);
      if (ms < now + lead) continue;                       // sudah lewat / terlalu mepet
      if (ms < earliest) continue;                         // produk ini masih cooldown
      if ((dayCount.get(tzDayKey(ms)) || 0) >= MAX_PER_DAY) continue;
      if (takenMin.has(Math.floor(ms / 60000))) continue;
      /* jarak minimum dari jadwal lain di platform yang sama */
      const tooClose = [...takenMin].some((m) => Math.abs(m * 60000 - ms) < S.settings.gapMin * 60000);
      if (tooClose) continue;
      return ms;
    }
  }
  return primeSlotFor(pf, 366, 0);
}

function autoSchedule(item, pf) {
  const p = plat(item, pf);
  if (p.status !== 'lolos') return false;      // hanya konten yang lolos boleh masuk antrean
  if (p.sched.at) return false;
  p.sched.at = suggestSlot(pf, item);
  return true;
}

function attemptPost(item, pf) {
  const s = plat(item, pf).sched;
  s.attempts += 1;
  const failed = Math.random() * 100 < S.settings.failRate;
  const label = pf === 'threads' ? 'Threads' : 'TikTok';

  if (!failed) {
    s.status = 'berhasil posting';
    s.postedAt = Date.now();
    s.lastError = null;
    s.gaveUp = false;
    log('ok', `${label} · ${item.name.slice(0, 34)}… berhasil diposting (percobaan ${s.attempts})`);
    return true;
  }

  const reasons = [
    'Timeout saat upload media',
    'Rate limit platform (429)',
    'Koneksi terputus di tengah upload',
    'Token sesi kedaluwarsa'
  ];
  s.lastError = pick(reasons, hash(item.key + pf) + s.attempts);
  if (s.attempts >= S.settings.maxAttempts) {
    s.gaveUp = true;
    log('err', `${label} · ${item.name.slice(0, 34)}… gagal ${s.attempts}x — perlu retry manual`);
  } else {
    s.at = Date.now() + S.settings.retryDelay * 60000 * s.attempts;
    log('err', `${label} · ${item.name.slice(0, 34)}… gagal (${s.lastError}). Retry dijadwalkan ${fmtSched(s.at)} ${tzLabel()}`);
  }
  return false;
}

/* ---------------- views ---------------- */
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { id: 'data', label: 'Data Produk', icon: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>' },
  { id: 'review', label: 'Review Konten', icon: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>' },
  { id: 'jadwal', label: 'Penjadwalan', icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>' },
  { id: 'pengaturan', label: 'Pengaturan', icon: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>' }
];

const PAGE_META = {
  dashboard: ['Dashboard', 'Ringkasan pipeline konten afiliasi'],
  data: ['Data Produk', 'Import & kelola data afiliasi Shopee'],
  review: ['Review Konten', 'Periksa, regenerate, atau batalkan konten sebelum dijadwalkan'],
  jadwal: ['Penjadwalan', 'Antrian posting & retry otomatis'],
  pengaturan: ['Pengaturan', 'Mode posting, retry, dan preferensi jadwal']
};

function counts() {
  const items = activeItems();
  const c = {
    total: items.length,
    withDetail: 0,
    pendingDetail: 0,
    pending: 0, approved: 0, regen: 0, cancelled: 0, noContent: 0,
    scheduled: 0, posted: 0, failed: 0,
    pendingThreads: 0, pendingTiktok: 0,
    approvedThreads: 0, approvedTiktok: 0,
    postedThreads: 0, postedTiktok: 0
  };
  items.forEach((i) => {
    if (i.detail) c.withDetail++;
    else c.pendingDetail++;
    ['threads', 'tiktok'].forEach((pf) => {
      const st = plat(i, pf).status;
      const cap = pf === 'threads' ? 'Threads' : 'Tiktok';
      /* "belum review" tanpa isi bukan pekerjaan review — itu masih perlu generate.
         Tanpa penjagaan ini, 10 produk baru langsung memunculkan badge 20. */
      if (st === 'belum review' && hasContent(i, pf)) { c.pending++; c['pending' + cap]++; }
      if (!hasContent(i, pf)) c.noContent++;
      if (st === 'regenerate') { c.regen++; c['pending' + cap]++; }
      if (st === 'lolos') { c.approved++; c['approved' + cap]++; }
      if (st === 'batal') c.cancelled++;
      const sc = plat(i, pf).sched;
      if (sc.status === 'belum post' && sc.at) c.scheduled++;
      if (sc.status === 'berhasil posting') { c.posted++; c['posted' + cap]++; }
      if (sc.gaveUp) c.failed++;
    });
  });
  return c;
}

function renderNav() {
  const c = counts();
  const badge = { review: c.pending, jadwal: c.scheduled };
  $('#nav').innerHTML = NAV.map((n) => `
    <button class="nav-item ${S.ui.view === n.id ? 'active' : ''}" data-act="nav" data-view="${n.id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${n.icon}</svg>
      <span>${n.label}</span>
      ${badge[n.id] ? `<span class="pill">${badge[n.id]}</span>` : ''}
    </button>`).join('');

  $('#sideCard').innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
      <span>Status penjadwal</span>
      <b style="color:${S.ui.running ? 'var(--ok)' : 'var(--muted)'}">${S.ui.running ? 'Berjalan' : 'Berhenti'}</b>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
      <span>Mode</span><b>${S.settings.mode === 'simulasi' ? 'Simulasi' : 'Manual'}</b>
    </div>
    <div style="display:flex;justify-content:space-between">
      <span>Konten lolos</span><b>${c.approved}/${c.total * 2}</b>
    </div>
    ${storageLine()}`;
}

function badgeFor(status) {
  const map = {
    'belum review': ['b-warn', 'Belum review'],
    'regenerate': ['b-info', 'Regenerate'],
    'lolos': ['b-ok', 'Lolos'],
    'batal': ['b-danger', 'Dibatalkan']
  };
  const [cls, label] = map[status] || ['b-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function postBadge(s) {
  if (s.status === 'berhasil posting') return `<span class="badge b-ok">Berhasil posting</span>`;
  if (s.gaveUp) return `<span class="badge b-danger">Gagal · retry manual</span>`;
  if (s.attempts > 0) return `<span class="badge b-warn">Belum post · retry ${s.attempts}x</span>`;
  return `<span class="badge b-gray">Belum post</span>`;
}

/* ---- dashboard ---- */
function activityCard() {
  return `
    <div class="card">
      <div class="card-head"><h3>Aktivitas</h3><span class="tiny muted">${S.logs.length} entri</span></div>
      <div class="card-body" style="max-height:340px;overflow:auto">
        ${S.logs.slice(0, 12).map((l) => `
          <div class="log">
            <div class="log-dot ${l.kind}"></div>
            <div class="log-txt">${esc(l.msg)}<div class="m">${fmtDateTime(l.ts)}</div></div>
          </div>`).join('') || '<div class="muted tiny">Belum ada aktivitas.</div>'}
      </div>
    </div>`;
}

function emptyStartCard() {
  return `
  <div class="card mb14">
    <div class="card-body">
      <div class="empty">
        <h4>Belum ada produk</h4>
        <p>Alur kerjanya lima tahap. Kamu hanya perlu menyiapkan bahan dan memutuskan; sisanya LLM.</p>
      </div>
      <ol class="tiny" style="line-height:2;padding-left:18px;margin-top:14px">
        <li><b>Kumpulkan</b> — kamu tempel CSV dari Shopee Affiliate di tab <b>Data Produk</b>.</li>
        <li><b>Ekstrak detail</b> — spesifikasi, ukuran, dan catatan toko dari halaman produk. Di server ini belum bisa dijalankan otomatis: akses Shopee Open API belum ada dan IP datacenter ditolak Shopee, jadi detail diimpor manual atau memakai data yang sudah ada.</li>
        <li><b>Generate</b> — LLM menulis utas Threads dan skrip TikTok, masing-masing bercabang per platform.</li>
        <li><b>Review</b> — kamu baca, tandai regenerate, atau loloskan. Hanya yang lolos yang boleh masuk antrean.</li>
        <li><b>Jadwal</b> — penjadwal memberi slot, konten tayang, lalu kamu tandai sudah posting.</li>
      </ol>
      <div class="row mt14">
        <button class="btn btn-primary" data-act="nav" data-view="data">Mulai dari Data Produk</button>
        <button class="btn" data-act="import-sample">Isi contoh 10 produk</button>
      </div>
      <div class="hint mt14">
        Tombol contoh mengisi 10 produk lengkap dengan detail, supaya kamu bisa mencoba generate → review → jadwal
        tanpa menunggu ekstraksi Shopee. Hapus lagi kapan saja dengan <b>Hapus semua produk</b>.
      </div>
    </div>
  </div>`;
}

function viewDashboard() {
  const c = counts();
  const pctThreads = c.total ? Math.round((c.approvedThreads / c.total) * 100) : 0;
  const pctTiktok = c.total ? Math.round((c.approvedTiktok / c.total) * 100) : 0;
  const pctPosted = (c.total * 2) ? Math.round((c.posted / (c.total * 2)) * 100) : 0;

  const stats = `
  <div class="stats">
    <div class="stat"><div class="stat-label">Produk aktif</div><div class="stat-value">${c.total}</div><div class="stat-sub">${c.withDetail}/${c.total} punya detail Shopee</div></div>
    <div class="stat accent"><div class="stat-label">Menunggu review</div><div class="stat-value">${c.pending}</div><div class="stat-sub">${c.regen} ditandai regenerate</div></div>
    ${c.noContent ? `<div class="stat"><div class="stat-label">Belum dibuat</div><div class="stat-value">${c.noContent}</div><div class="stat-sub">dari ${c.total * 2} slot konten</div></div>` : ''}
    <div class="stat ok"><div class="stat-label">Konten lolos</div><div class="stat-value">${c.approved}</div><div class="stat-sub">siap masuk antrian</div></div>
    <div class="stat"><div class="stat-label">Sudah diposting</div><div class="stat-value">${c.posted}</div><div class="stat-sub">${c.scheduled} terjadwal</div></div>
    ${c.failed ? `<div class="stat warn"><div class="stat-label">Perlu perhatian</div><div class="stat-value">${c.failed}</div><div class="stat-sub">gagal, menunggu retry manual</div></div>` : ''}
  </div>`;

  /* keadaan kosong: jangan tampilkan tabel 0 dan grafik 0% — beri jalan masuk */
  if (!c.total) {
    return `${stats}
    ${emptyStartCard()}
    <div class="grid-2">${activityCard()}
      <div class="card">
        <div class="card-head"><h3>Yang dibutuhkan sebelum mulai</h3></div>
        <div class="card-body stack">
          <div class="pline"><span>CSV dari Shopee Affiliate</span><b>wajib</b></div>
          <div class="pline"><span>Detail produk (skrip ekstraksi)</span><b>sangat disarankan</b></div>
          <div class="pline"><span>API key LLM</span><b>wajib</b></div>
          <div class="hint mt8">
            Semua konten ditulis LLM, jadi API key (atau Base URL proxy) harus diisi dulu di tab <b>Pengaturan</b>.
            Tanpa itu tombol Generate dimatikan.
          </div>
        </div>
      </div>
    </div>`;
  }

  return `${stats}

  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h3>Progres pipeline</h3><span class="tiny muted">${c.posted}/${c.total * 2} konten terposting</span></div>
      <div class="card-body stack">
        <div>
          <div class="pline"><span>Threads — lolos review</span><b>${c.approvedThreads}/${c.total}</b></div>
          <div class="progress"><i style="width:${pctThreads}%"></i></div>
        </div>
        <div>
          <div class="pline"><span>TikTok — lolos review</span><b>${c.approvedTiktok}/${c.total}</b></div>
          <div class="progress"><i style="width:${pctTiktok}%"></i></div>
        </div>
        <div>
          <div class="pline"><span>Posting selesai</span><b>${c.posted}/${c.total * 2}</b></div>
          <div class="progress ok"><i style="width:${pctPosted}%"></i></div>
        </div>
        <div class="section-title" style="margin:16px 0 6px">Distribusi plot konten</div>
        ${PLOT_ORDER.map((pl) => `<div class="pline"><span>${pl.toUpperCase()} · ${PLOTS[pl].name}</span><b>${activeItems().filter((i) => i.plot === pl).length}</b></div>`).join('')}
        <div class="hint mt8">
          Alur: <b>generate</b> → <b>review</b> (belum review / regenerate / batal / lolos) → <b>jadwal</b> (belum post / berhasil posting, gagal = retry otomatis).
        </div>
      </div>
    </div>

    ${activityCard()}
  </div>

  <div class="section-title">Produk dengan performa terbaik</div>
  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Produk</th><th>Harga</th><th>Terjual</th><th>Komisi</th><th>Threads</th><th>TikTok</th></tr></thead>
        <tbody>
          ${activeItems().slice().sort((a, b) => b.soldNum - a.soldNum).slice(0, 5).map((i) => `
            <tr>
              <td class="td-name"><div class="n">${esc(i.name)}</div><div class="s">${esc(i.shop)}</div></td>
              <td class="num">${esc(i.priceText)}</td>
              <td class="num">${esc(i.soldText)}</td>
              <td class="num">${esc(i.commText)}</td>
              <td>${badgeFor(plat(i, 'threads').status)}</td>
              <td>${badgeFor(plat(i, 'tiktok').status)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ---- data produk ---- */
function viewData() {
  const items = activeItems();
  const pendingDetail = items.filter((i) => i.detailStatus !== 'ok');
  /* Detail sudah ada tapi folder assets/<id>/ masih kosong -> tinggal unduh
     gambar/video. Dihitung terpisah supaya angkanya tidak tertukar. */
  const pendingMedia = items.filter((i) => i.detailStatus === 'ok' && !assetsOf(i).length);
  const perluKerja = pendingDetail.length + pendingMedia.length;
  const meta = S.meta || {};
  const riwayat = Array.isArray(S.riwayat) ? S.riwayat : [];
  const batches = {};
  items.forEach((i) => { const b = i.batchId || '-'; batches[b] = (batches[b] || 0) + 1; });
  const batchList = Object.keys(batches).sort().reverse().slice(0, 4);

  const detailCell = (i) => {
    if (i.detailStatus === 'ok') return `<button class="btn btn-xs" data-act="detail" data-key="${i.key}">Lihat ✓</button>`;
    if (i.detailStatus === 'gagal') return `<span class="badge b-danger" title="Ekstraksi terakhir gagal">gagal</span>`;
    /* Teks belum ada tapi media sudah: tetap bisa dibuka, isinya gambar/video. */
    if (assetsOf(i).length) return `<button class="btn btn-xs" data-act="detail" data-key="${i.key}">Aset saja</button>`;
    return `<span class="badge b-warn">belum</span>`;
  };

  return `
  ${shopeeBlocked() ? `<div class="hint mb14">
    <b>Detail produk memakai data yang sudah ada.</b>
    ${(SHOPEE_CAP && SHOPEE_CAP.reason === 'dimatikan')
      ? 'Ekstraksi detail dimatikan lewat konfigurasi server.'
      : 'Akses <b>Shopee Open API</b> belum tersedia, dan server ini berjalan di IP datacenter — halaman produk tidak bisa dibuka dari sini.'}
    Konten tetap dibuat dari katalog (nama, harga, terjual, toko, komisi) plus detail yang pernah diekstrak.
    <button class="btn btn-xs" data-act="shopee-notice" style="margin-left:6px">Kenapa?</button>
  </div>` : ''}
  ${perluKerja ? `
  <div class="card mb14" style="border-color:var(--warn)">
    <div class="card-body">
      <h3 style="margin:0 0 4px">${pendingDetail.length
        ? `${pendingDetail.length} produk belum punya detail Shopee`
        : `${pendingMedia.length} produk belum punya aset media`}</h3>
      <div class="tiny muted">${(pendingDetail.length ? pendingDetail : pendingMedia).slice(0, 3).map((i) => esc(i.name.slice(0, 42))).join(' · ')}${(pendingDetail.length ? pendingDetail : pendingMedia).length > 3 ? ` · +${(pendingDetail.length ? pendingDetail : pendingMedia).length - 3} lainnya` : ''}</div>
      <div class="hint mt8">
        ${pendingDetail.length
          ? 'Detail dipakai untuk spesifikasi resmi, catatan ukuran, dan catatan logistik di dalam konten. Tanpa detail, konten tetap bisa digenerate — tapi isinya jadi umum dan gampang mirip produk lain.'
          : 'Detailnya sudah lengkap. Yang belum ada hanya gambar dan video produk — keduanya diunduh dari halaman Shopee yang sama dan disimpan ke folder aset.'}
      </div>
      <div class="row mt14">
        <button class="btn btn-primary" data-act="extract-now">Ambil detail + media (${perluKerja})</button>
        <button class="btn" data-act="export-pending">Unduh pending.json</button>
        <button class="btn" data-act="import-detail">Import hasil manual (JSON)</button>
        <div class="spacer"></div>
        <span class="tiny muted">${shopeeBlocked() ? 'menunggu akses Shopee Open API' : 'ekstraksi jalan dari sini — tanpa terminal'}</span>
      </div>
    </div>
  </div>` : ''}

  <div class="card mb14">
    <div class="card-head">
      <h3>Tambah data afiliasi</h3>
      <span class="tiny muted">CSV: ID Produk, Nama Produk, Harga, Penjualan, Nama Toko, Komisi hingga, Komisi, Link Produk, Link Komisi Ekstra</span>
    </div>
    <div class="card-body">
      <textarea class="textarea" id="csvInput" style="min-height:120px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px" placeholder="Tempel baris CSV di sini (boleh termasuk baris header)…"></textarea>
      <div class="row mt8">
        <button class="btn btn-primary" data-act="import-csv">Import / update data</button>
        <button class="btn" data-act="import-sample">Isi contoh 10 produk</button>
        <button class="btn btn-ghost" data-act="clear-all">Hapus semua produk</button>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-act="state-export">Backup data</button>
        <button class="btn btn-sm" data-act="state-import">Pulihkan backup</button>
        <span class="tiny muted" id="importInfo"></span>
      </div>
      <div class="hint mt14">
        Import bersifat <b>upsert</b>: produk yang sudah ada diperbarui katalognya (harga, terjual, komisi, link),
        konten yang sudah <b>lolos</b> atau <b>sudah tayang</b> tidak disentuh. Kamu akan lihat pratinjaunya dulu sebelum diterapkan.
      </div>
    </div>
  </div>

  <div class="card mb14">
    <div class="card-head">
      <h3>Status batch</h3>
      <span class="badge b-brand">${esc(meta.lastImportBatch || '-')}</span>
    </div>
    <div class="card-body">
      ${items.length ? `
      <div class="kv"><span>Import terakhir</span><b>${meta.lastImportAt ? fmtDateTime(meta.lastImportAt) : '—'}</b></div>
      <div class="kv"><span>Masuk batch itu</span><b>${meta.lastImportAdded || 0} baru · ${meta.lastImportTouched || 0} diperbarui</b></div>
      <div class="kv"><span>Produk aktif</span><b>${items.length}</b></div>
      <div class="kv"><span>Belum punya detail Shopee</span><b>${pendingDetail.length}</b></div>
      <div class="kv"><span>Belum punya media (gambar/video)</span><b>${pendingMedia.length}</b></div>
      <div class="row mt14">
        <button class="btn btn-sm btn-primary" data-act="extract-now" ${perluKerja ? '' : 'disabled'}>Ambil detail + media (${perluKerja})</button>
        <button class="btn btn-sm" data-act="export-pending" ${perluKerja ? '' : 'disabled'}>Unduh pending.json</button>
        <button class="btn btn-sm" data-act="import-detail">Import hasil manual (JSON)</button>
      </div>
      <div class="hint mt8">
        ${shopeeBlocked()
          ? `<b>Ambil detail + media</b> belum bisa dijalankan dari server ini: akses Shopee Open API belum ada dan IP datacenter ditolak Shopee. Detail baru bisa masuk lewat <b>Import hasil manual (JSON)</b> dari mesin yang punya akses.`
          : `<b>Ambil detail + media</b> menjalankan skrip dari server: detail produk (spesifikasi, varian, deskripsi)
        masuk ke database, gambar dan video produk diunduh ke <code>assets/&lt;id&gt;/</code>. Tanpa terminal.
        Butuh Chrome terpasang dan koneksi internet.`}
      </div>
      ${batchList.length ? `<div class="tiny muted mt8">Batch tersimpan: ${batchList.map((b) => `${esc(b)} (${batches[b]})`).join(' · ')}</div>` : ''}
      ` : `
      <div class="empty" style="padding:18px 8px">
        <h4>Belum ada produk</h4>
        <p>Semua produk sudah dihapus permanen. Import CSV di kartu atas untuk memulai batch baru — hitungan batch akan mulai dari nol lagi.</p>
      </div>`}
    </div>
  </div>

  ${riwayat.length ? `
  <div class="card mb14">
    <div class="card-head">
      <h3>Riwayat tayang</h3>
      <span class="badge b-ok">${riwayat.length} postingan</span>
    </div>
    <div class="card-body">
      <div class="tiny muted">Produk yang dihapus tetap meninggalkan jejak postingan yang sudah berhasil tayang. Ini sengaja disimpan — isinya tidak lagi ikut dihitung sebagai produk aktif, tidak masuk jadwal, dan tidak bisa digenerate.</div>
      <div class="table-wrap mt14">
        <table>
          <thead><tr><th>Produk</th><th>Platform</th><th>Tayang</th><th></th></tr></thead>
          <tbody>
            ${riwayat.slice(0, 12).map((r, idx) => Object.keys(r.platforms || {}).map((pf) => `
              <tr>
                <td class="td-name"><div class="n">${esc(r.name || '-')}</div><div class="s">${esc(r.shop || '')} · ID ${esc(r.productId || '-')}</div></td>
                <td><span class="badge b-gray">${esc(pf)}</span></td>
                <td class="tiny muted">${r.platforms[pf].sched && r.platforms[pf].sched.postedAt ? fmtSched(r.platforms[pf].sched.postedAt) + ' ' + tzLabel() : '—'}</td>
                <td class="num"><button class="btn btn-xs" data-act="riwayat-lihat" data-rw="${idx}" data-pf="${esc(pf)}">Lihat</button></td>
              </tr>`).join('')).join('')}
          </tbody>
        </table>
      </div>
      <div class="row mt14">
        <button class="btn btn-sm btn-ghost" data-act="riwayat-bersihkan">Kosongkan riwayat tayang</button>
        <div class="spacer"></div>
        <span class="tiny muted">${riwayat.length > 12 ? `menampilkan 12 dari ${riwayat.length} produk` : ''}</span>
      </div>
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-head"><h3>Daftar produk</h3><span class="tiny muted">${items.length} produk aktif</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Produk</th><th>Kategori</th><th>Harga</th><th>Terjual</th><th>Komisi</th><th>Detail</th><th>Aset</th><th>Batch</th><th>Link</th><th></th></tr></thead>
        <tbody>
          ${items.map((i) => `
            <tr>
              <td class="td-name">
                <div class="n">${esc(i.name)}</div>
                <div class="s">${esc(i.shop)} · ID ${esc(i.productId)}</div>
                ${i.priceDrift ? `<div class="tiny" style="color:var(--warn)">harga berubah ${esc(i.priceDrift.from)} → ${esc(i.priceDrift.to)}</div>` : ''}
              </td>
              <td><span class="badge b-gray">${catOf(i).label}</span></td>
              <td class="num">${esc(i.priceText)}</td>
              <td class="num">${esc(i.soldText)}</td>
              <td class="num">${esc(i.commText)} <span class="tiny muted">(${esc(i.commRate)})</span></td>
              <td>${detailCell(i)}</td>
              <td>${assetsOf(i).length ? `<button class="btn btn-xs" data-act="aset-lihat" data-key="${i.key}">${assetsOf(i).length} file</button>` : '<span class="badge b-gray">belum</span>'}</td>
              <td class="tiny muted">${esc(i.batchId || '-')}</td>
              <td><a href="${esc(i.affiliateUrl)}" target="_blank" rel="noopener" class="tiny">buka ↗</a></td>
              <td><button class="btn btn-sm btn-danger" data-act="del-item" data-key="${i.key}">Hapus</button></td>
            </tr>`).join('') || `<tr><td colspan="10"><div class="empty"><h4>Belum ada produk</h4><p>Import CSV dulu untuk mulai generate konten.</p></div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

}`;
}

/* ---- review ---- */
function viewReview() {
  const pf = S.ui.reviewTab;
  const filter = S.ui.reviewFilter;
  const items = activeItems();
  const cnt = {
    semua: items.length,
    kosong: items.filter((i) => !hasContent(i, pf)).length,
    'belum review': items.filter((i) => plat(i, pf).status === 'belum review' && hasContent(i, pf)).length,
    regenerate: items.filter((i) => plat(i, pf).status === 'regenerate' && hasContent(i, pf)).length,
    lolos: items.filter((i) => plat(i, pf).status === 'lolos' && hasContent(i, pf)).length,
    batal: items.filter((i) => plat(i, pf).status === 'batal' && hasContent(i, pf)).length
  };
  const FILTERS = ['semua', 'kosong', 'belum review', 'regenerate', 'lolos', 'batal'];
  const FILTER_LABEL = { semua: 'Semua', kosong: 'Belum dibuat', 'belum review': 'Belum review', regenerate: 'Regenerate', lolos: 'Lolos', batal: 'Batal' };

  let list = items;
  if (filter === 'kosong') list = list.filter((i) => !hasContent(i, pf));
  else if (filter !== 'semua') list = list.filter((i) => plat(i, pf).status === filter && hasContent(i, pf));

  /* Semua produk bisa digenerate: detail hanya menambah spesifikasi dan
     catatan ukuran. Yang belum punya detail dihitung terpisah supaya
     keterangannya jujur — bukan untuk memblokir tombolnya. */
  const siapGenerate = items.filter((i) => !hasContent(i, pf)).length;
  const tanpaDetail = items.filter((i) => !hasContent(i, pf) && !draftReady(i)).length;

  return `
  <div class="toolbar">
    <div class="segmented">
      <button class="${pf === 'threads' ? 'active' : ''}" data-act="tab" data-pf="threads">Threads <span class="cnt">${items.filter(i => plat(i, 'threads').status === 'lolos').length}/${items.length}</span></button>
      <button class="${pf === 'tiktok' ? 'active' : ''}" data-act="tab" data-pf="tiktok">TikTok <span class="cnt">${items.filter(i => plat(i, 'tiktok').status === 'lolos').length}/${items.length}</span></button>
    </div>
    <div class="segmented">
      ${FILTERS.map((f) => `
        <button class="${filter === f ? 'active' : ''}" data-act="filter" data-f="${f}">${FILTER_LABEL[f]} <span class="cnt">${cnt[f]}</span></button>`).join('')}
    </div>
    <div class="spacer"></div>
    ${siapGenerate ? `<button class="btn btn-sm btn-primary" data-act="gen-ready" data-pf="${pf}" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>Generate ${siapGenerate} draf</button>` : ''}
    ${pf === 'threads' ? `<button class="btn btn-sm" data-act="rotate-plots" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>↻ Rotasi plot</button>` : ''}
    <button class="btn btn-sm" data-act="regen-flagged" data-pf="${pf}" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>Regenerate yang ditandai (${cnt.regenerate})</button>
    <button class="btn btn-sm btn-ok" data-act="approve-all" data-pf="${pf}">Lolos semua</button>
  </div>

  ${pf === 'threads' ? `<div class="hint mb14">
    <b>Aturan utas:</b> 3–5 post · tiap post <b>250–500</b> karakter (target 440–485) · dipisah <code>-----</code> ·
    maksimal 2 emoji per utas · link afiliasi hanya di post terakhir · tanpa hashtag.
    Kalimat tidak pernah terpotong antar post, dan antar paragraf cukup satu baris.
    Jumlah post mengikuti panjang isi yang dihasilkan.
    Struktur mengikuti plot: <b>P1</b> honest review · <b>P2</b> skeptis → kemakan · <b>P3</b> matematika orang malas · <b>P4</b> dua kubu.
  </div>` : `<div class="hint mb14">
    <b>Aturan TikTok:</b> 1 revisi = 1 video · hook selesai di 3 detik pertama · minimal 3 scene ·
    on-screen text maks 6 kata · caption maks 2.200 karakter · link di bio, bukan di caption.
  </div>`}

  ${tanpaDetail ? `<div class="hint mb14">
    <b>${tanpaDetail} produk akan digenerate dari data katalog</b> karena detail Shopee-nya belum ada.
    Draf tetap dibuat dari nama, harga, terjual, toko, dan komisi — tanpa spesifikasi, fitur,
    dan catatan ukuran, jadi hasilnya lebih umum.
    <button class="btn btn-xs" data-act="shopee-notice" style="margin-left:6px">Kenapa detail belum ada?</button>
  </div>` : ''}

  <div class="review-grid">
    ${list.map((i) => pf === 'threads' ? threadsCard(i) : tiktokCard(i)).join('') || (items.length === 0
      ? `<div class="empty"><h4>Belum ada produk untuk direview</h4><p>Import CSV di tab Data Produk, lalu generate konten. Konten yang sudah dibuat akan muncul di sini per platform.</p><div class="row" style="justify-content:center;margin-top:12px"><button class="btn btn-primary" data-act="nav" data-view="data">Buka Data Produk</button></div></div>`
      : `<div class="empty"><h4>Tidak ada konten di filter ini</h4><p>Ubah filter atau generate konten baru dari tab Data Produk.</p></div>`)}
  </div>`;
}

/* ---------------- aset per item ----------------
   File disimpan di assets/<productId>/. Browser tidak bisa membaca daftar file,
   jadi daftarnya datang dari assets/manifest.js hasil scripts/scan_assets.py. */

const ASSETS = (typeof window !== 'undefined' && window.ASSET_MANIFEST) || { items: {} };

/* Server membaca isi folder assets/ langsung, jadi media yang baru diunduh
   muncul tanpa perlu menjalankan scripts/scan_assets.py atau reload paksa. */
async function refreshAssets() {
  if (STORE.mode !== 'server') return false;
  try {
    const r = await fetch(API + '/assets', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    ASSETS.items = j.items || {};
    return true;
  } catch (e) {
    return false;
  }
}

function assetsOf(item) {
  if (!item || !item.productId) return [];
  return (ASSETS.items && ASSETS.items[item.productId]) || [];
}

function assetUrl(item, file) {
  return 'assets/' + encodeURIComponent(item.productId) + '/' + encodeURIComponent(file);
}

function assetStrip(item) {
  const all = assetsOf(item);
  if (!all.length) {
    return `<div class="asset-empty tiny muted">Belum ada aset. Taruh file di <code>assets/${esc(item.productId || '')}/</code> lalu jalankan <code>python scripts/scan_assets.py</code>.</div>`;
  }
  const imgs = all.filter((a) => a.kind === 'image' && !/-thumb\.jpg$/i.test(a.file));
  const vids = all.filter((a) => a.kind === 'video');
  return `
  <div class="asset-strip">
    ${imgs.slice(0, 6).map((a) => `<img src="${assetUrl(item, a.file)}" alt="${esc(a.file)}" title="${esc(a.file)}" loading="lazy">`).join('')}
    ${imgs.length > 6 ? `<span class="asset-more tiny">+${imgs.length - 6}</span>` : ''}
    ${vids.length ? `<span class="badge b-info">${vids.length} video</span>` : ''}
    <span class="tiny muted">${all.length} aset</span>
  </div>`;
}

/* Baris mana yang sedang terbuka. Disimpan di memori, BUKAN di state: kalau
   ikut disimpan, tiap klik buka/tutup akan menulis ulang database dan menaikkan
   revisi — cukup untuk memicu konflik di tab lain. */
const _revOpen = new Set();
/* panel <details> di dalam kartu (riwayat revisi, detail produk) juga diingat
   supaya tidak menutup sendiri setiap kali render setelah aksi. */
const _detOpen = new Set();

/* Status pipeline yang sedang berjalan, per item+platform. Hanya di memori:
   ini keadaan sesaat (detik ini Planner jalan), bukan data yang layak disimpan.
   Isinya diisi oleh callback runAgentPipeline — tidak ada timer, tidak ada
   animasi. Kalau sebuah langkah tidak benar-benar berjalan, tidak ada yang
   menyala di layar. */
const _agentLive = new Map();   // 'key|pf' -> { step, iter, startedAt, done: [{step, iter, ms}] }
const AGENT_LABEL = { planner: 'Planner', writer: 'Writer', reviewer: 'Reviewer' };
const AGENT_ORDER = ['planner', 'writer', 'reviewer'];

/* bahasa terakhir yang dipilih di modal "Prompt video" (id | en). Tidak ikut
   disimpan ke database, sama seperti _revOpen. */
let _vpLang = 'id';
/* penanda urutan permintaan terjemahan, supaya jawaban LLM yang datang
   terlambat tidak menimpa textarea yang sudah diganti user. */
let _vpSeq = 0;

/* Satu baris ringkas per produk. Daftar 50 produk tetap bisa dipindai tanpa
   scroll panjang; klik barisnya untuk membuka editor penuh di tempat. */
function rrowHead(i, pf) {
  const p = plat(i, pf);
  const ada = hasContent(i, pf);
  let info = 'belum ada draf';
  if (ada) {
    if (pf === 'threads') {
      const posts = p.posts || [];
      const total = posts.reduce((a, b) => a + b.length, 0);
      info = `${posts.length} post · ${total} karakter`;
    } else {
      info = `${(p.scenes || []).length} scene · ${p.duration || '24 detik'}`;
    }
  }
  return `
  <summary class="rrow-sum">
    <span class="rrow-ico">${catOf(i).icon}</span>
    <span class="rrow-main">
      <span class="rrow-name">${esc(i.name)}</span>
      <span class="rrow-sub">${esc(i.priceText)} · ${esc(i.soldText)} terjual · ${esc(i.shop)} · ${esc(info)}</span>
    </span>
    <span class="rrow-badges">
      ${ada && p.source === 'llm' ? '<span class="badge b-info">LLM</span>' : ''}
      ${videoBadge(i, pf, { hideMissing: !ada })}
      ${ada ? agentBadge(p) : ''}
      ${ada ? revBadge(p) : ''}
      ${badgeFor(p.status)}
    </span>
    <span class="rrow-chev">›</span>
  </summary>`;
}

function detailPanel(item) {
  const d = item.detail;
  if (!d) {
    return `<div class="det-empty">Detail produk belum diekstrak. Jalankan <code>python scripts/extract_batch.py</code> lalu refresh.</div>`;
  }
  const specs = String(d.specs || '').split('|').map((s) => s.trim())
    .filter((s) => s && !/tidak garansi|belum ada|^mystery box: ya$/i.test(s));
  return `
  <details class="det">
    <summary>
      <span>Detail produk dari Shopee</span>
      <span class="tiny muted">${esc(d.variations || '')}</span>
    </summary>
    <div class="det-body">
      <div class="det-k">Spesifikasi resmi</div>
      <div class="det-chips">${specs.slice(0, 12).map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="tiny muted">—</span>'}</div>
      <div class="det-k mt8">Catatan logistik</div>
      <div class="det-v">${esc(d.logistics || '—')}</div>
      <div class="det-k mt8">Deskripsi penjual</div>
      <div class="det-desc">${esc((d.raw_description || '').slice(0, 900)) || '—'}</div>
    </div>
  </details>`;
}

function cardFoot(i, pf) {
  const st = plat(i, pf).status;
  const v = validateContent(i, pf);
  const nVid = pf === 'tiktok' ? mediaOf(plat(i, pf)).videos.length : 0;
  /* Tombol Lolos mencerminkan keadaan sebenarnya: putih + tanpa centang selama
     konten belum diloloskan, hijau + centang setelah lolos. Sebelumnya tombol
     selalu hijau dan bercentang, jadi terlihat seperti sudah lolos padahal
     belum. */
  const approved = st === 'lolos';
  const approveTitle = v.ok
    ? (approved ? 'Sudah lolos review' : 'Tandai konten ini lolos review')
    : 'Belum memenuhi aturan — lihat catatan di atas';
  return `
  <div class="alive-slot" data-live="${i.key}|${pf}">${agentLiveHtml(i.key, pf)}</div>
  <div class="rcard-foot">
    <button class="btn btn-sm ${approved ? 'btn-ok' : ''}" data-act="approve" data-key="${i.key}" data-pf="${pf}" title="${approveTitle}">${approved ? '✓ Lolos' : 'Lolos'}</button>
    <button class="btn btn-sm" data-act="regen-now" data-key="${i.key}" data-pf="${pf}" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>↻ Regenerate</button>
    <button class="btn btn-sm" data-act="flag" data-key="${i.key}" data-pf="${pf}">Tandai regenerate</button>
    <button class="btn btn-sm" data-act="cancel" data-key="${i.key}" data-pf="${pf}">Batalkan</button>
    <button class="btn btn-sm btn-danger" data-act="del-draft" data-key="${i.key}" data-pf="${pf}">Hapus draf</button>
    ${st === 'batal' ? `<button class="btn btn-sm" data-act="restore" data-key="${i.key}" data-pf="${pf}">Pulihkan</button>` : ''}
    <div class="spacer"></div>
    ${pf === 'tiktok' ? `<button class="btn btn-sm btn-ghost" data-act="video-prompt" data-key="${i.key}">Prompt video</button>
    <button class="btn btn-sm btn-ghost" data-act="video-media" data-key="${i.key}">Video${nVid ? ` · ${nVid}` : ''}</button>` : ''}
    <button class="btn btn-sm btn-ghost" data-act="preview" data-key="${i.key}" data-pf="${pf}">Preview</button>
    <button class="btn btn-sm btn-ghost" data-act="copy" data-key="${i.key}" data-pf="${pf}">Salin</button>
  </div>`;
}

/* catatan validasi: apa yang menghalangi tombol Lolos */
function validationHint(item, pf) {
  const v = validateContent(item, pf);
  if (v.ok) return `<div class="tiny muted mb14">Valid · siap lolos</div>`;
  return `<div class="hint warn mb14"><b>Belum bisa lolos:</b> ${v.reasons.slice(0, 4).map(esc).join(' · ')}${v.reasons.length > 4 ? ` · +${v.reasons.length - 4} lagi` : ''}</div>`;
}

function revBadge(p) {
  return `<span class="badge" title="Revisi ke-${p.rev} · riwayat ${(p.history || []).length}">rev ${p.rev}</span>`;
}

/* riwayat revisi: yang lama tidak dihapus, tapi yang sudah tayang tidak bisa
   dipulihkan diam-diam — tombolnya berubah jadi "posting ulang". */
function historyPanel(item, pf) {
  const p = plat(item, pf);
  const h = (p.history || []).slice().sort((a, b) => b.rev - a.rev);
  if (!h.length) return '';
  const dkey = item.key + '|' + pf + '|rev';
  return `
  <details class="det" data-det="${esc(dkey)}"${_detOpen.has(dkey) ? ' open' : ''}>
    <summary>
      <span>Riwayat revisi (${h.length})</span>
      <span class="tiny muted">aktif: rev ${p.rev}</span>
    </summary>
    <div class="det-body">
      ${h.map((s) => {
        const posted = !!(s.sched && s.sched.postedAt);
        return `
        <div class="row" style="justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)">
          <div class="tiny">
            <b>rev ${s.rev}</b> · ${esc((PLOTS[s.plot] || PLOTS.p1).name)} ·
            ${s.posts ? s.posts.length + ' post · ' + s.posts.reduce((a, b) => a + b.length, 0) + ' kar' : esc(s.duration || 'video')}
            ${posted ? ' <span class="badge b-ok">sudah tayang</span>' : ''}
            <div class="muted">${esc(s.at ? fmtSched(s.at) + " " + tzLabel() : '')}</div>
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button class="btn btn-xs ${posted ? 'btn-danger' : ''}" data-act="restore-rev" data-key="${item.key}" data-pf="${pf}" data-rev="${s.rev}">
              ${posted ? 'Posting ulang versi ini' : 'Pulihkan'}
            </button>
            <button class="btn btn-xs btn-ghost" data-act="del-rev" data-key="${item.key}" data-pf="${pf}" data-rev="${s.rev}" title="Hapus revisi ini dari riwayat">Hapus</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </details>`;
}

/* jejak agent: siapa bilang apa, aturan mana yang dilanggar, iterasi ke berapa.
   Ini bukan hiasan — ini satu-satunya alasan sebuah draf bisa dipercaya atau
   ditolak, dan satu-satunya bukti kalau keputusannya dipertanyakan nanti. */
const ROLE_LABEL = { planner: 'Planner', writer: 'Writer', reviewer: 'Reviewer', system: 'Sistem', human: 'Manusia' };

/* durasi dalam detik, koma seperti kebiasaan Indonesia: 7,0 dtk */
function fmtMs(ms) {
  return (Math.round(ms / 100) / 10).toFixed(1).replace('.', ',') + ' dtk';
}

/* strip langkah yang menyala selama pipeline berjalan. Isinya murni dari
   callback runAgentPipeline: sebuah chip hanya menyala kalau langkah itu
   benar-benar sedang dieksekusi, dan angkanya adalah waktu yang benar-benar
   terpakai. Tidak ada timer yang berpura-pura. */
function agentLiveHtml(key, pf) {
  const st = _agentLive.get(key + '|' + pf);
  if (!st) return '';
  const doneMs = {};
  st.done.forEach((d) => { doneMs[d.step] = (doneMs[d.step] || 0) + d.ms; });
  const chips = AGENT_ORDER.map((s) => {
    const ms = doneMs[s];
    const active = st.step === s;
    const cls = ms ? 'done' : (active ? 'on' : 'wait');
    const val = ms ? fmtMs(ms) : (active ? '…' : '—');
    return `<span class="astep ${cls}"><b>${AGENT_LABEL[s]}</b><i>${val}</i></span>`;
  }).join('<span class="aarrow">›</span>');
  const secs = ((Date.now() - st.startedAt) / 1000).toFixed(1).replace('.', ',');
  return `<div class="alive-box">
    <div class="alive-head"><span class="alive-dot"></span>Pipeline berjalan · ${secs} dtk · iterasi ${st.iter || 1}</div>
    <div class="asteps">${chips}</div>
  </div>`;
}

function paintAgentLive(key, pf) {
  const host = document.querySelector(`[data-live="${key}|${pf}"]`);
  if (host) host.innerHTML = agentLiveHtml(key, pf);
  const st = _agentLive.get(key + '|' + pf);
  const btn = document.querySelector(`[data-act="regen-now"][data-key="${key}"][data-pf="${pf}"]`);
  if (btn && st) btn.textContent = st.step ? AGENT_LABEL[st.step] + '…' : 'Memproses…';
}

/* detik berjalan perlu diperbarui supaya terlihat hidup; yang diperbarui hanya
   angka waktu, bukan status langkah. Berhenti sendiri saat tidak ada yang jalan. */
let _agentTick = null;
function agentTickStart() {
  if (_agentTick) return;
  _agentTick = setInterval(() => {
    if (!_agentLive.size) { clearInterval(_agentTick); _agentTick = null; return; }
    _agentLive.forEach((v, k) => {
      const i = k.indexOf('|');
      paintAgentLive(k.slice(0, i), k.slice(i + 1));
    });
  }, 500);
}

function agentBadge(p) {
  const r = p && p.review;
  if (!r) return '';
  if (r.state === 'escalated') {
    return `<span class="badge b-danger" title="Batas 3 iterasi tercapai dan masih ada pelanggaran — butuh keputusan manusia">eskalasi</span>`;
  }
  if (r.verdict === 'lulus') {
    const n = (r.warned || []).length;
    return `<span class="badge b-ok" title="Reviewer menyatakan lulus dalam ${r.iterations} iterasi${n ? `, dengan ${n} catatan` : ''}">agent · lulus</span>`;
  }
  return '';
}

function agentPanel(item, pf) {
  const p = plat(item, pf);
  const r = p.review;
  const trace = p.trace || [];
  if (!r && !trace.length) return '';
  const dkey = item.key + '|' + pf + '|agent';
  const esc2 = r && r.state === 'escalated';
  const blocked = (r && r.blocked) || [];

  const rowHtml = (t) => {
    const role = ROLE_LABEL[t.role] || t.role;
    const iter = t.iter ? `<span class="tiny muted">iterasi ${t.iter}</span>` : '';
    const dur = t.ms ? `<span class="tiny muted">· ${fmtMs(t.ms)}</span>` : '';
    const body = `<div class="arow-t">${esc(t.text)}</div>`;
    if (t.role === 'writer') {
      return `<details class="arow-det">
        <summary><span class="arole writer">Writer</span>${iter}<span class="tiny muted">${t.text.length} karakter</span>${dur}</summary>
        ${body}
      </details>`;
    }
    return `<div class="arow"><div class="arow-h"><span class="arole ${t.role}">${role}</span>${iter}${dur}</div>${body}</div>`;
  };

  /* ringkasan tiga peran + waktu masing-masing. Terbaca tanpa mengklik apa pun,
     dan tetap terbaca di screenshot statis — penting karena penilaian putaran
     pertama dilakukan dari berkas, bukan dari demo hidup. */
  const steps = (r && r.steps) || {};
  const summary = AGENT_ORDER.map((s) => {
    const ms = steps[s];
    return `<span class="astep ${ms ? 'done' : 'wait'}"><b>${AGENT_LABEL[s]}</b><i>${ms ? fmtMs(ms) : '—'}</i></span>`;
  }).join('<span class="aarrow">›</span>');

  return `
  <details class="det" data-det="${esc(dkey)}"${(_detOpen.has(dkey) || esc2) ? ' open' : ''}>
    <summary>
      <span>Jejak agent (${(r && r.iterations) || trace.filter((t) => t.role === 'writer').length} iterasi · ${trace.length} langkah)</span>
      ${r ? `<span class="badge ${esc2 ? 'b-danger' : 'b-ok'}">${esc2 ? 'eskalasi ke manusia' : 'lulus'}</span>` : ''}
    </summary>
    <div class="det-body">
      <div class="asteps mb10">${summary}</div>
      ${trace.map(rowHtml).join('')}
      ${esc2 ? `<div class="hint" style="border-color:var(--danger)">
        <b>Batas ${AGENT_MAX_ITER} iterasi tercapai, masih ada pelanggaran.</b>
        Pipeline berhenti di sini — tidak ada perulangan tanpa batas.
        Sisa masalah: ${blocked.slice(0, 4).map((v) => `<b>${esc(v.ruleId)}</b> ${esc(v.evidence)}`).join(' · ') || '—'}.
        ${r && r.override
          ? `<div class="tiny muted mt8">Sudah disetujui manusia: ${esc(r.override.note || 'tanpa catatan')}</div>`
          : `<div class="row mt8"><button class="btn btn-sm" data-act="override" data-key="${item.key}" data-pf="${pf}">Setujui dengan catatan</button></div>`}
      </div>` : ''}
      ${r && r.degraded ? `<div class="tiny muted">Reviewer LLM tidak tersedia saat generate ini — penilaian hanya dari mesin aturan deterministik.</div>` : ''}
    </div>
  </details>`;
}

/* Apakah produk punya detail hasil ekstraksi (spesifikasi, fitur, catatan
   ukuran, ongkir, klaim toko). Ini bukan syarat generate lagi: detail hanya
   menambah bahan. Tanpa detail, draf dibuat dari katalog dan hasilnya lebih
   umum — UI menjelaskan itu, bukan memblokir. */
function draftReady(item) {
  return !!(item && item.detail);
}

function emptyDraftBody(i, pf) {
  const label = pf === 'threads' ? 'Threads' : 'TikTok';
  const siap = draftReady(i);
  const err = plat(i, pf).error;
  return `
  <div class="empty" style="margin:0">
    <h4>Belum ada draf ${label}</h4>
    <p>${siap
      ? 'Detail produk sudah ada. Draf ditulis LLM saat kamu menekan Generate — bukan otomatis saat import.'
      : 'Detail produk belum ada, jadi draf dibuat dari data katalog: nama, harga, terjual, toko, dan komisi. Spesifikasi dan catatan ukuran tidak ikut.'}</p>
    ${err ? `<div class="hint warn" style="text-align:left">Generate terakhir gagal: ${esc(err)}</div>` : ''}
    <div class="row" style="justify-content:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-primary" data-act="regen-now" data-key="${i.key}" data-pf="${pf}" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>Generate ${label} sekarang</button>
      ${siap ? '' : `<button class="btn" data-act="shopee-notice">Kenapa detail belum ada?</button>`}
    </div>
  </div>`;
}

function threadsCard(i) {
  const p = plat(i, 'threads');
  const buka = _revOpen.has(i.key) ? ' open' : '';
  const cls = `rrow${p.status === 'lolos' ? ' is-approved' : ''}${p.status === 'batal' ? ' is-cancelled' : ''}`;
  if (!hasContent(i, 'threads')) {
    return `<details class="${cls}" data-rkey="${i.key}"${buka}>
      ${rrowHead(i, 'threads')}
      <div class="rrow-body"><div class="rcard-body">${emptyDraftBody(i, 'threads')}</div></div>
    </details>`;
  }
  const posts = plat(i, 'threads').posts || [];
  const total = posts.reduce((a, b) => a + b.length, 0);
  const over = posts.filter((p) => p.length > 500).length;
  return `
  <details class="${cls}" data-rkey="${i.key}"${buka}>
    ${rrowHead(i, 'threads')}
    <div class="rrow-body"><div class="rcard-body">
      <div class="plot-row">
        <span class="badge b-brand">${(PLOTS[i.plot] || PLOTS.p1).name}</span>
        <select class="select plot-select" data-plot="${i.key}">
          ${PLOT_ORDER.map((p) => `<option value="${p}" ${p === plat(i, 'threads').plot ? 'selected' : ''}>${p.toUpperCase()} · ${PLOTS[p].name}</option>`).join('')}
        </select>
        <span class="tiny muted">${esc((PLOTS[plat(i, 'threads').plot] || PLOTS.p1).desc)}</span>
        ${revBadge(plat(i, 'threads'))}
        ${plat(i, 'threads').source === 'llm' ? `<span class="badge b-info" title="${esc(plat(i, 'threads').model || '')}">LLM</span>` : ''}
        <button class="btn btn-sm" data-act="ai-one" data-key="${i.key}" data-pf="threads" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>⚡ Generate</button>
      </div>
      ${plat(i, 'threads').status === 'batal' ? `<div class="hint warn mb14">Draf ini <b>dibatalkan</b> — isinya masih tersimpan tapi tidak bisa diedit. Tekan <b>Pulihkan</b> untuk mengaktifkan lagi, atau <b>Hapus draf</b> untuk mengosongkannya.</div>` : ''}
      ${plat(i, 'threads').error ? `<div class="hint warn mb14">LLM gagal: ${esc(plat(i, 'threads').error)}</div>` : ''}
      ${validationHint(i, 'threads')}
      <div class="field-label">
        <span>Utas Threads · ${posts.length} post</span>
        <span class="tiny ${over ? 'counter over' : 'muted'}">${over ? over + ' post kelebihan karakter' : total + ' karakter total'}</span>
      </div>
      ${posts.map((p, idx) => `
        <div class="tpost ${p.length > 500 ? 'is-over' : ''}">
          <div class="tpost-head">
            <span class="tpost-n">Post ${idx + 1}${idx === 0 ? ' · hook' : idx === posts.length - 1 ? ' · pivot + link' : ''}</span>
            <span class="counter ${p.length > 500 ? 'over' : ''}">${p.length}/500</span>
          </div>
          <textarea class="textarea" rows="4" data-edit="threads.posts.${idx}" data-key="${i.key}" ${plat(i, 'threads').status === 'batal' ? 'disabled' : ''}>${esc(p)}</textarea>
        </div>`).join('<div class="tsep">-----</div>')}
      <div class="tiny muted mt8">Link afiliasi: <a href="${esc(i.affiliateUrl)}" target="_blank" rel="noopener">${esc(i.affiliateUrl)}</a></div>
      ${assetStrip(i)}
      ${agentPanel(i, 'threads')}
      ${historyPanel(i, 'threads')}
      ${detailPanel(i)}
    </div></div>
    ${cardFoot(i, 'threads')}
  </details>`;
}

/* Scene TikTok punya dua bentuk di database:
   - string biasa  -> hasil LLM (skema JSON di tiktokSystem: scenes: string[])
   - objek {time, visual, overlay, vo} -> sisa data lama dari generator template
   Renderer dulu hanya mengenal bentuk objek, jadi setiap kali draft ditulis LLM
   storyboard-nya tampil kosong (semua field undefined). sceneRows() menyeragamkan
   keduanya sebelum dirender. */
function sceneRows(scenes) {
  return (scenes || []).map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    if (s && typeof s === 'object') {
      return {
        n,
        time: String(s.time || '').trim(),
        visual: String(s.visual || s.text || s.scene || '').trim(),
        overlay: String(s.overlay || '').trim(),
        vo: String(s.vo || '').trim()
      };
    }
    return { n, time: '', visual: String(s == null ? '' : s).trim(), overlay: '', vo: '' };
  }).filter((r) => r.visual || r.overlay || r.vo);
}

function sceneBlock(scenes) {
  const rows = sceneRows(scenes);
  if (!rows.length) return '<div class="tiny muted">Storyboard belum ada — tekan Generate untuk mengisinya.</div>';
  return rows.map((r) => `
    <div class="scene">
      <div class="scene-time">${esc(r.time || r.n)}</div>
      <div>
        <div class="scene-visual">${esc(r.visual)}</div>
        ${r.overlay ? `<span class="scene-overlay">${esc(r.overlay)}</span>` : ''}
        ${r.vo ? `<div class="scene-vo">VO: ${esc(r.vo)}</div>` : ''}
      </div>
    </div>`).join('');
}

/* Prompt siap tempel untuk generator video (Veo, Kling, Sora, Pika, Hailuo).
   Disusun dari draf TikTok yang sudah ada: hook, storyboard, teks cover, musik.
   Link afiliasi sengaja TIDAK dimasukkan — banyak platform video menolak atau
   menonaktifkan prompt yang berisi URL.

   Durasi & rasio TIDAK diambil dari draf (draf menulis 0:20–0:30 karena itu
   panjang video TikTok), tapi dari pilihan user: klip dasar Veo di Gemini cuma
   4–8 detik dan rasionya default 16:9. Kalau prompt meminta 30 detik, model
   tidak menuruti — yang terjadi justru 5 adegan dipadatkan jadi 8 detik. */
const _vpOpts = { dur: '9', ratio: '9:16', scenes: 'auto' };
const VP_DUR = [['8', '8 detik'], ['9', '9 detik'], ['10', '10 detik'], ['long', '20–30 detik']];
const VP_RATIO = ['9:16', '16:9'];
/* Detik per adegan yang dianggap masih nyaman. Di bawah ~2 detik, penonton
   tidak sempat melihat produknya dan model video mulai mengacak isi frame.
   Dipakai untuk menentukan jumlah adegan otomatis dari durasi klip. */
const VP_SEC_PER_SCENE = 2.4;
const VP_NOTE_ID = 'Tempel ke generator video (Veo, Kling, Sora, Pika, Hailuo). Bisa diedit dulu sebelum disalin. Link afiliasi sengaja tidak dimasukkan — banyak platform video menolak prompt yang berisi URL. Durasi dan rasio tetap ditentukan setelan di aplikasi generatornya (Veo di Gemini: 4–8 detik, 16:9 default), jadi pilih juga di sana — teks prompt tidak bisa memaksa.';
/* cache terjemahan: kunci = item + durasi + rasio, supaya ganti-ganti pilihan
   tidak memanggil LLM berkali-kali untuk isi yang sama. */
const _vpEnCache = new Map();

function vpOrient(ratio) {
  return ratio === '16:9'
    ? { id: 'horizontal 16:9 (1920x1080)', en: 'horizontal 16:9 (1920x1080)' }
    : { id: 'vertikal 9:16 (1080x1920)', en: 'vertical 9:16 (1080x1920)' };
}
function vpSpan(o) {
  if (o.dur === 'long') return { id: '20–30 detik', en: '20-30 seconds', sec: 0 };
  return { id: o.dur + ' detik', en: o.dur + ' seconds', sec: Number(o.dur) };
}
/* catatan pemadatan: hanya relevan kalau durasi klip lebih pendek dari yang
   dibutuhkan adegan-adegan di draf. */
function vpFitNote(sec, n, lang) {
  if (!sec || !n) return '';
  const per = (sec / n).toFixed(1).replace('.', lang === 'en' ? '.' : ',');
  if (lang === 'en') {
    return `DURATION NOTE: only ${sec} seconds for ${n} shots, so each shot lasts about ${per} second and cuts fast. Do not stretch a shot and do not add new ones. The product must already be visible before the 2-second mark — do not spend the opening on the problem shot. If something must be dropped, merge similar shots — never drop shot 01 or the last shot.`;
  }
  return `CATATAN DURASI: hanya ${sec} detik untuk ${n} adegan, jadi tiap adegan sekitar ${per} detik dan dipotong cepat. Jangan memperpanjang adegan dan jangan menambah adegan baru. Produk harus sudah terlihat sebelum detik ke-2 — jangan menghabiskan waktu di adegan pembuka. Kalau harus memangkas, gabungkan adegan yang mirip — jangan buang adegan 01 dan adegan terakhir.`;
}

/* arahan komposisi. Berguna terutama saat generator mengabaikan rasio: kalau
   hasilnya tetap 16:9 padahal kita minta 9:16, subjek yang diletakkan di tengah
   masih selamat waktu di-crop.
   PENTING: jangan pernah menyebut "UI TikTok", "caption", atau "tombol" di sini.
   Dulu baris ini berbunyi "...ruang aman untuk UI TikTok (caption dan tombol)"
   dan hasilnya model benar-benar MENGGAMBAR antarmuka TikTok lengkap dengan
   avatar, jumlah suka, dan menu bawah di detik terakhir. Model video mengikuti
   kata benda yang disebut, bukan maksud kalimatnya. Jadi ruang aman ditulis
   sebagai "ruang kosong", tanpa menyebut platform atau elemennya. */
function vpFrameNote(ratio, lang) {
  if (lang === 'en') {
    return ratio === '16:9'
      ? 'Framing: keep the subject centred with spare room on the left and right, so the clip still works if cropped to 9:16 later.'
      : 'Framing: vertical composition, subject centred, leave roughly 15% empty margin at the top and bottom.';
  }
  return ratio === '16:9'
    ? 'Komposisi: subjek utama di tengah, sisakan ruang di kiri dan kanan supaya tetap aman kalau nanti di-crop ke 9:16.'
    : 'Komposisi: vertikal, subjek utama di tengah, sisakan ruang kosong sekitar 15% di bagian atas dan bawah.';
}

/* Adegan dari draf TikTok kadang menyebut elemen antarmuka ("keranjang kuning",
   "link di bio", "browsing online shop") yang tidak mungkin difilmkan. Kalau
   dibiarkan, model mengarang objek aneh di frame. Catatan ini hanya ditambahkan
   kalau ada adegan yang memang menyebut hal seperti itu.
   Daftar kata kuncinya sengaja lebar: "browsing online shop" dulu lolos dan
   tidak memicu catatan apa pun.
   Kalimatnya sengaja POSITIF ("frame bersih, hanya subjek dan latar") dan tidak
   merinci benda. Menyebut "badge, notifikasi, ikon" justru memancing model
   menggambar benda-benda itu — negasi tidak dipatuhi model video. */
const VP_UI_RX = new RegExp([
  'keranjang', 'bakul', 'link', '\\bbio\\b', 'checkout', 'swipe', 'klik',
  'tombol', 'ikon', 'aplikasi', '\\bapp\\b', 'shopee', 'tokopedia', 'lazada',
  'tiktok shop', 'online shop', 'toko online', 'browsing', 'marketplace',
  'e-?commerce', 'screenshot', 'tangkapan layar', 'scroll', '\\bfeed\\b',
  'google', 'ponsel', 'smartphone', 'layar hp', 'di hp\\b', 'notifikasi'
].join('|'), 'i');
function vpUiNote(rows, lang) {
  if (!rows.some((r) => VP_UI_RX.test(r.visual) || VP_UI_RX.test(r.overlay || ''))) return '';
  return lang === 'en'
    ? 'Keep the image clean: only the person, the product, and the room behind them. Nothing drawn on top of the footage. If a shot needs a phone screen or a store page, film it at an angle, out of focus and unreadable, and let a hand gesture stand in for it.'
    : 'Gambar harus bersih: hanya orang, produk, dan ruangan di belakangnya. Tidak ada apa pun yang digambar menimpa rekaman. Kalau sebuah adegan butuh layar ponsel atau halaman toko, rekam dari sudut miring, tidak fokus, dan tidak terbaca — cukup gestur tangan sebagai gantinya.';
}

/* Jumlah adegan menyesuaikan durasi. Draf TikTok menulis 5 adegan karena
   panjang kontennya 20–30 detik; kalau klipnya cuma 9 detik, 5 adegan berarti
   1,8 detik per adegan — terlalu padat, penonton tidak sempat melihat produk
   dan model video mulai mengacak isi frame. Adegan yang berdekatan DIGABUNG,
   bukan dibuang, supaya alur cerita tetap utuh dari pembuka ke penutup. */
function vpLowerFirst(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^[A-Z]{2}/.test(t)) return t;          // biarkan akronim: HP, TV, RCA
  return t.charAt(0).toLowerCase() + t.slice(1);
}
function vpMergeScenes(rows, want) {
  const n = rows.length;
  if (!n || want >= n) return rows.slice();
  /* penghubung diputar supaya penggabungan tiga adegan tidak jadi
     "lalu ... lalu ..." yang kaku. */
  const JOIN = ['lalu', 'kemudian', 'setelah itu'];
  const out = [];
  for (let i = 0; i < want; i++) {
    const from = Math.floor((i * n) / want);
    const to = Math.max(Math.floor(((i + 1) * n) / want), from + 1);
    const group = rows.slice(from, to);
    let acc = group[0].visual;
    for (let k = 1; k < group.length; k++) {
      /* buang titik/koma di ujung kalimat sebelumnya, kalau tidak hasilnya
         jadi "... bentuk fisiknya. lalu menyetel musik ..." */
      acc = acc.replace(/[.;,:]+$/, '');
      /* pilih penghubung yang belum dipakai di kalimat sebelumnya — teks asli
         kadang sudah mengandung "lalu", jadi jangan diulang. */
      const conn = JOIN.find((c) => !new RegExp('\\b' + c + '\\b', 'i').test(acc)) || JOIN[0];
      acc += ' ' + conn + ' ' + vpLowerFirst(group[k].visual);
    }
    out.push({
      n: String(i + 1).padStart(2, '0'),
      visual: acc,
      overlay: (group.find((g) => g.overlay) || {}).overlay || '',
      vo: group.map((g) => g.vo).filter(Boolean).join(' ')
    });
  }
  return out;
}
function vpSceneCount(rows, o, sec) {
  const n = rows.length;
  if (!n) return 0;
  if (o.scenes && o.scenes !== 'auto') return Math.max(2, Math.min(Number(o.scenes) || n, n));
  if (!sec) return n;                          // durasi panjang: pakai semua adegan
  return Math.max(2, Math.min(n, Math.round(sec / VP_SEC_PER_SCENE)));
}
function vpPickScenes(rows, o, sec) {
  return vpMergeScenes(rows, vpSceneCount(rows, o, sec));
}
/* teks kecil di modal: "4 adegan · 2,3 detik/adegan" */
function vpCountLabel(rows, o, sec) {
  const n = vpSceneCount(rows, o, sec);
  if (!n) return '';
  const per = sec ? ' · ' + (sec / n).toFixed(1).replace('.', ',') + ' detik/adegan' : '';
  return n + ' adegan' + per;
}

function videoPrompt(it, opt) {
  const o = opt || _vpOpts;
  const t = plat(it, 'tiktok');
  const raw = sceneRows(t.scenes);
  const span = vpSpan(o);
  const rows = vpPickScenes(raw, o, span.sec);
  const ori = vpOrient(o.ratio);
  const L = [];
  L.push(`Video ${ori.id}, SATU klip ${span.id}, gaya handheld natural seperti rekaman sendiri, bukan iklan. Satu orang, satu produk, tanpa aktor tambahan.`);
  L.push('');
  L.push('PRODUK: ' + it.name + (it.priceText ? ' — ' + it.priceText : ''));
  if (t.hook) {
    L.push('');
    L.push('HOOK (detik pertama, harus langsung kena):');
    L.push(t.hook);
  }
  if (rows.length) {
    L.push('');
    L.push('STORYBOARD:');
    rows.forEach((r) => {
      L.push(`${r.n}. ${r.visual}` +
        (r.overlay ? ` (teks di layar: ${r.overlay})` : '') +
        (r.vo ? ` (VO: ${r.vo})` : ''));
    });
  }
  L.push('');
  if (t.coverText) L.push('TEKS DI LAYAR UTAMA (tulis persis dalam Bahasa Indonesia, jangan diganti): ' + t.coverText);
  if (t.music) L.push('MUSIK: ' + t.music);
  if (t.caption) {
    L.push('');
    L.push('NARASI (boleh jadi VO, jangan ditulis penuh di layar):');
    L.push(t.caption);
  }
  const fit = vpFitNote(span.sec, rows.length, 'id');
  if (fit) { L.push(''); L.push(fit); }
  const ui = vpUiNote(raw, 'id');
  if (ui) { L.push(''); L.push('CATATAN ELEMEN LAYAR: ' + ui); }
  L.push('');
  L.push('ATURAN VISUAL:');
  L.push('- ' + vpFrameNote(o.ratio, 'id'));
  L.push('- Gambar bersih: hanya orang, produk, dan ruangan di belakangnya. Tidak ada apa pun yang digambar menimpa rekaman, termasuk di tepi frame.');
  L.push('- Produk yang sama, bentuk dan warna identik di setiap adegan.');
  L.push('- Cahaya indoor natural, bukan gaya studio iklan.');
  L.push('- Tanpa pose jualan: tidak ada jempol ke kamera, tidak ada menatap kamera sambil tersenyum di akhir, tidak ada gerakan tangan ala iklan.');
  L.push('- Tangan dan wajah manusia normal, tidak cacat, jari tidak berlebih.');
  L.push('- Tanpa teks tambahan di luar yang disebutkan, tanpa watermark, tanpa logo.');
  L.push('- Jangan menampilkan harga atau angka yang tidak ada di data produk.');
  L.push('');
  L.push(`OUTPUT: 1 klip video ${span.id}, ${ori.id}, gambar bersih tanpa lapisan tambahan di atasnya.`);
  return L.join('\n');
}

/* Versi Inggris tanpa LLM: kerangkanya sudah Inggris, isi adegan masih
   mengikuti draf TikTok apa adanya. Dipakai sebagai cadangan kalau LLM belum
   dikonfigurasi atau terjemahannya gagal. */
function videoPromptEN(it, opt) {
  const o = opt || _vpOpts;
  const t = plat(it, 'tiktok');
  const raw = sceneRows(t.scenes);
  const span = vpSpan(o);
  const rows = vpPickScenes(raw, o, span.sec);
  const ori = vpOrient(o.ratio);
  const L = [];
  L.push(`Single ${ori.en} clip, ${span.en} long, natural handheld look like a self-recorded video, not an ad. One person, one product, no extra actors.`);
  L.push('');
  L.push('PRODUCT: ' + it.name + (it.priceText ? ' - ' + it.priceText : ''));
  if (t.hook) {
    L.push('');
    L.push('HOOK (first second, spoken in Indonesian):');
    L.push(t.hook);
  }
  if (rows.length) {
    L.push('');
    L.push('STORYBOARD:');
    rows.forEach((r) => {
      L.push(`${r.n}. ${r.visual}` +
        (r.overlay ? ` (on-screen text: ${r.overlay})` : '') +
        (r.vo ? ` (VO: ${r.vo})` : ''));
    });
  }
  L.push('');
  if (t.coverText) L.push('MAIN ON-SCREEN TEXT (Indonesian, write exactly as given, do not rephrase): ' + t.coverText);
  if (t.music) L.push('MUSIC: ' + t.music);
  if (t.caption) {
    L.push('');
    L.push('NARRATION (Indonesian, may be used as VO, do not print in full on screen):');
    L.push(t.caption);
  }
  const fit = vpFitNote(span.sec, rows.length, 'en');
  if (fit) { L.push(''); L.push(fit); }
  const ui = vpUiNote(raw, 'en');
  if (ui) { L.push(''); L.push('ON-SCREEN ELEMENTS: ' + ui); }
  L.push('');
  L.push('VISUAL RULES:');
  L.push('- ' + vpFrameNote(o.ratio, 'en'));
  L.push('- Clean image: only the person, the product, and the room behind them. Nothing drawn on top of the footage, including at the frame edges.');
  L.push('- Same product, identical shape and colour in every shot.');
  L.push('- Natural indoor light, not a studio commercial look.');
  L.push('- No sales poses: no thumbs up to camera, no smiling straight at the lens at the end, no advertising hand gestures.');
  L.push('- Anatomically correct hands and face, no extra fingers.');
  L.push('- No extra text beyond what is listed, no watermark, no logo.');
  L.push('- Do not show prices or numbers that are not in the product data.');
  L.push('');
  L.push(`OUTPUT: one clip, ${span.en}, ${ori.en}, clean image with nothing layered over it.`);
  return L.join('\n');
}

/* Terjemahan penuh lewat LLM: instruksi dan arahan visual jadi Inggris, tapi
   teks yang nanti benar-benar diucapkan atau tampil di video (hook, teks layar,
   narasi) SENGAJA dibiarkan Bahasa Indonesia — videonya untuk audiens Indonesia,
   yang perlu dipahami generator cuma instruksinya. */
async function translatePromptEN(idText) {
  const sys = [
    'You are a translator for short-form video production prompts.',
    'Translate the user prompt from Indonesian into natural, directive English for AI video generators (Veo, Kling, Sora, Pika, Hailuo).',
    '',
    'TRANSLATE INTO ENGLISH:',
    '- All section labels (use the English equivalent, keep them uppercase).',
    '- All storyboard visual directions.',
    '- Music direction, camera/lighting notes, and every visual rule.',
    '',
    'DO NOT TRANSLATE — keep exactly as written in Indonesian:',
    '- The HOOK line (it is spoken on camera).',
    '- MAIN ON-SCREEN TEXT / cover text (it appears on screen).',
    '- The NARRATION / caption body (it becomes the voice-over).',
    '- Product and brand names, every number, measurement, weight, volume, and price.',
    'After each of those kept-in-Indonesian sections, make clear in English that it is meant to stay in Indonesian, e.g. "HOOK (first second, spoken in Indonesian):".',
    '',
    'OTHER RULES:',
    '- Keep the same structure and section order.',
    '- Keep the numbered storyboard items in the same order and same count.',
    '- Keep the tone of the original: plain instruction, not marketing copy.',
    '- Do not add new scenes, new claims, or new numbers. Do not drop any scene.',
    '- Output only the translated prompt. No preamble, no notes, no explanation, no markdown fences.'
  ].join('\n');
  const usr = 'PROMPT (Indonesian) — translate to English:\n\n' + idText;
  const out = await callLLM(aiCfg(), sys, usr, 60000);
  const txt = String(out || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  if (txt.length < 120) throw new Error('hasil terjemahan terlalu pendek');
  return txt;
}

/* Isi textarea dengan versi EN. Kalau LLM siap, diterjemahkan; kalau tidak,
   pakai kerangka Inggris statis. Aman dipanggil berkali-kali. */
async function vpShowEN(it) {
  const seq = ++_vpSeq;
  const ta = document.querySelector('[data-vprompt]');
  if (!ta) return;
  const note = () => document.querySelector('[data-vpnote]');
  const apply = (txt, msg) => {
    if (seq !== _vpSeq) return;                       // sudah diganti permintaan lain
    const t = document.querySelector('[data-vprompt]');
    if (!t) return;                                   // modal sudah ditutup
    t.value = txt;
    delete t.dataset.busy;
    const n = note();
    if (n) n.textContent = msg;
  };

  if (!aiReady()) {
    apply(videoPromptEN(it), 'LLM belum dikonfigurasi, jadi ini versi EN cadangan: label sudah Inggris, isi adegan masih Bahasa Indonesia. Isi konfigurasi LLM di Pengaturan untuk terjemahan penuh.');
    return;
  }

  /* hasil terjemahan untuk kombinasi item+durasi+rasio yang sama tidak perlu
     diminta dua kali — ganti-ganti pilihan jadi instan. */
  const ck = it.key + '|' + _vpOpts.dur + '|' + _vpOpts.ratio + '|' + _vpOpts.scenes;
  if (_vpEnCache.has(ck)) {
    apply(_vpEnCache.get(ck), 'Terjemahan LLM. Periksa ulang nama produk dan angka sebelum disalin.');
    return;
  }

  ta.dataset.busy = '1';
  ta.value = 'Menerjemahkan ke Bahasa Inggris lewat LLM…';
  const n0 = note();
  if (n0) n0.textContent = 'Menerjemahkan lewat LLM…';
  try {
    const en = await translatePromptEN(videoPrompt(it));
    _vpEnCache.set(ck, en);
    apply(en, 'Terjemahan LLM. Periksa ulang nama produk dan angka sebelum disalin.');
  } catch (e) {
    apply(videoPromptEN(it), 'Terjemahan LLM gagal (' + (e.message || 'error') + '). Ini versi EN cadangan: label sudah Inggris, isi adegan masih Bahasa Indonesia.');
  }
}


function tiktokCard(i) {
  const p = plat(i, 'tiktok');
  const buka = _revOpen.has(i.key) ? ' open' : '';
  const cls = `rrow${p.status === 'lolos' ? ' is-approved' : ''}${p.status === 'batal' ? ' is-cancelled' : ''}`;
  if (!hasContent(i, 'tiktok')) {
    return `<details class="${cls}" data-rkey="${i.key}"${buka}>
      ${rrowHead(i, 'tiktok')}
      <div class="rrow-body"><div class="rcard-body">${emptyDraftBody(i, 'tiktok')}</div></div>
    </details>`;
  }
  const t = plat(i, 'tiktok');
  return `
  <details class="${cls}" data-rkey="${i.key}"${buka}>
    ${rrowHead(i, 'tiktok')}
    <div class="rrow-body"><div class="rcard-body">
      <div class="plot-row">
        ${plat(i, 'tiktok').source === 'llm' ? `<span class="badge b-info" title="${esc(plat(i, 'tiktok').model || '')}">LLM</span>` : ''}
        ${revBadge(plat(i, 'tiktok'))}
        <button class="btn btn-sm" data-act="ai-one" data-key="${i.key}" data-pf="tiktok" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>⚡ Generate</button>
        <span class="tiny muted">${esc((PLOTS[plat(i, 'tiktok').plot] || PLOTS.p1).name)}</span>
      </div>
      ${plat(i, 'tiktok').status === 'batal' ? `<div class="hint warn mb14">Draf ini <b>dibatalkan</b> — isinya masih tersimpan tapi tidak bisa diedit. Tekan <b>Pulihkan</b> untuk mengaktifkan lagi, atau <b>Hapus draf</b> untuk mengosongkannya.</div>` : ''}
      ${plat(i, 'tiktok').error ? `<div class="hint warn mb14">LLM gagal: ${esc(plat(i, 'tiktok').error)}</div>` : ''}
      ${validationHint(i, 'tiktok')}
      <div class="field">
        <div class="field-label"><span>Hook (3 detik pertama)</span><span class="counter">${(t.hook || '').length}</span></div>
        <textarea class="textarea" rows="2" data-edit="tiktok.hook" data-key="${i.key}" ${plat(i, 'tiktok').status === 'batal' ? 'disabled' : ''}>${esc(t.hook)}</textarea>
      </div>

      <div class="field">
        <div class="field-label"><span>Storyboard · ${esc(t.duration || '24 detik')}</span><span class="tiny" style="text-transform:none;letter-spacing:0">${esc(t.music || '')}</span></div>
        <div style="border:1px solid var(--line);border-radius:10px;padding:4px 12px;background:#fcfcfd">
          ${sceneBlock(t.scenes)}
        </div>
      </div>

      <div class="field">
        <div class="field-label"><span>Caption TikTok</span><span class="counter">${(t.caption || '').length}/2200</span></div>
        <textarea class="textarea" rows="6" data-edit="tiktok.caption" data-key="${i.key}" ${plat(i, 'tiktok').status === 'batal' ? 'disabled' : ''}>${esc(t.caption)}</textarea>
      </div>

      <div class="field">
        <div class="field-label"><span>Teks cover</span></div>
        <textarea class="textarea" rows="2" data-edit="tiktok.coverText" data-key="${i.key}" ${plat(i, 'tiktok').status === 'batal' ? 'disabled' : ''}>${esc(t.coverText)}</textarea>
      </div>
      ${videoStrip(i)}
      ${assetStrip(i)}
      ${agentPanel(i, 'tiktok')}
      ${historyPanel(i, 'tiktok')}
      ${detailPanel(i)}
    </div></div>
    ${cardFoot(i, 'tiktok')}
  </details>`;
}

/* ---- jadwal ---- */
function viewJadwal() {
  const rows = [];
  activeItems().forEach((i) => {
    ['threads', 'tiktok'].forEach((pf) => {
      const st = plat(i, pf).status;
      if (st !== 'lolos' && !plat(i, pf).sched.at) return;
      rows.push({ i, pf, s: plat(i, pf).sched });
    });
  });
  rows.sort((a, b) => (a.s.at || Infinity) - (b.s.at || Infinity));

  const f = S.ui.schedFilter;
  const shown = f === 'semua' ? rows : rows.filter((r) => f === 'berhasil' ? r.s.status === 'berhasil posting' : r.s.status !== 'berhasil posting');

  return `
  <div class="toolbar">
    <div class="segmented">
      <button class="${f === 'semua' ? 'active' : ''}" data-act="sched-filter" data-f="semua">Semua <span class="cnt">${rows.length}</span></button>
      <button class="${f === 'belum' ? 'active' : ''}" data-act="sched-filter" data-f="belum">Belum post <span class="cnt">${rows.filter(r => r.s.status !== 'berhasil posting').length}</span></button>
      <button class="${f === 'berhasil' ? 'active' : ''}" data-act="sched-filter" data-f="berhasil">Berhasil posting <span class="cnt">${rows.filter(r => r.s.status === 'berhasil posting').length}</span></button>
    </div>
    <div class="spacer"></div>
    <button class="btn btn-sm ${S.ui.running ? 'btn-ok' : 'btn-primary'}" data-act="toggle-run">${S.ui.running ? '⏸ Hentikan penjadwal' : '▶ Jalankan penjadwal'}</button>
    <button class="btn btn-sm" data-act="autoschedule">Jadwalkan otomatis semua</button>
    <button class="btn btn-sm" data-act="reschedule">Atur ulang ke jam prime</button>
    <button class="btn btn-sm" data-act="run-now">Jalankan yang jatuh tempo</button>
  </div>

  ${S.settings.mode === 'manual' ? `<div class="hint warn mb14">Mode <b>manual</b> aktif: sistem tidak memposting sendiri. Klik <b>Posting sekarang</b> pada baris yang jatuh tempo, copy caption, posting manual di platform, lalu tandai hasilnya.</div>` : `<div class="hint mb14">Mode <b>simulasi</b> aktif: penjadwal mencoba posting otomatis sesuai jam, dengan simulasi tingkat gagal ${S.settings.failRate}% dan retry maksimal ${S.settings.maxAttempts}x.</div>`}

  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Produk</th><th>Platform</th><th>Jadwal (jam audiens · ${tzLabel()})</th><th>Status</th><th>Percobaan</th><th>Catatan</th><th></th></tr></thead>
        <tbody>
          ${shown.map(({ i, pf, s }) => `
            <tr>
              <td class="td-name"><div class="n">${esc(i.name)}</div><div class="s">${esc(i.shop)}</div></td>
              <td><span class="badge ${pf === 'threads' ? 'b-brand' : 'b-info'}">${pf === 'threads' ? 'Threads' : 'TikTok'}</span> ${videoBadge(i, pf, { warn: true })}</td>
              <td><input type="datetime-local" class="input" style="max-width:180px;font-size:11.8px;padding:5px 8px" value="${toAudienceInput(s.at)}" data-sched="${i.key}|${pf}"><div class="tiny muted" style="margin-top:3px;min-height:13px">${s.at ? (primeNote(pf, s.at) || 'manual · di luar jam prime') : 'belum dijadwalkan'}</div></td>
              <td>${postBadge(s)}</td>
              <td class="num">${s.attempts}</td>
              <td class="tiny muted" style="max-width:180px">${s.lastError ? esc(s.lastError) : s.postedAt ? 'Posted ' + fmtSched(s.postedAt) + ' ' + tzLabel() : '—'}</td>
              <td>
                <div class="row" style="gap:5px;flex-wrap:nowrap">
                  <button class="btn btn-xs" data-act="post-now" data-key="${i.key}" data-pf="${pf}">Posting</button>
                  <button class="btn btn-xs btn-ghost" data-act="reset-post" data-key="${i.key}" data-pf="${pf}">Reset</button>
                </div>
              </td>
            </tr>`).join('') || `<tr><td colspan="7"><div class="empty"><h4>Belum ada konten terjadwal</h4><p>Konten yang sudah berstatus <b>lolos</b> akan muncul di sini dan otomatis dapat slot jadwal.</p></div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ================= LLM cloud =================
   Satu konfigurasi untuk semua teks (Threads & TikTok). Bentuk lama
   {threads:{...}, tiktok:{...}} dimigrasikan sekali di sini memakai isi
   kartu Threads — konfigurasi yang dulu dipakai untuk menulis teks. */
/* --- apakah server mengurus key LLM sendiri? ---
   Di VPS, key tidak boleh sampai ke browser: siapa pun bisa membacanya lewat
   DevTools, dan endpoint-nya bisa dipakai orang lain untuk menghabiskan kuota.
   Kalau /api/llm/status menjawab configured, semua panggilan LLM diarahkan ke
   proksi server dan key di state diabaikan. Kalau tidak (mis. di localhost
   dengan gateway sendiri), perilaku lama tetap dipakai. */
let SERVER_LLM = null;
async function probeServerLlm() {
  try {
    const r = await fetch('/api/llm/status', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.configured) {
      SERVER_LLM = d;
      // Penanda di <html> supaya mode ini bisa diperiksa dari luar
      // (uji otomatis, atau sekadar lihat Inspect Element) tanpa membuka
      // panel log.
      document.documentElement.dataset.llmServer = '1';
      log('info', 'LLM diurus server — key tidak disimpan di browser');
    }
  } catch (e) { /* server tanpa proksi LLM: pakai setelan pengguna */ }
}

function aiCfg() {
  const A = S.ai = S.ai || {};
  if (!A.text) {
    const old = A.threads || A.tiktok || {};
    A.text = { ...AI_DEFAULT };
    Object.keys(AI_DEFAULT).forEach((k) => { if (old[k] !== undefined) A.text[k] = old[k]; });
  }
  Object.keys(AI_DEFAULT).forEach((k) => { if (A.text[k] === undefined) A.text[k] = AI_DEFAULT[k]; });
  delete A.text.on;          // toggle "pakai LLM" sudah dihapus
  delete A.threads; delete A.tiktok;

  // 1. Mode server: satu key di .env VPS, dipakai semua pengunjung.
  //    Ini yang utama — setelan di browser tidak boleh menimpanya, karena
  //    pengunjung tidak seharusnya perlu mengurus key sendiri.
  //    baseUrl harus absolut: normalizeBase() menambahkan "http://" pada path
  //    relatif, sehingga '/api/llm' akan menjadi 'http:///api/llm'.
  if (SERVER_LLM && SERVER_LLM.configured) {
    return {
      ...A.text,
      baseUrl: location.origin + (SERVER_LLM.basePath || '/api/llm'),
      key: '',
      model: SERVER_LLM.model || A.text.model
    };
  }

  // 2. Tanpa LLM server (mis. localhost dengan gateway sendiri): pakai setelan
  //    yang disimpan di browser ini.
  if (lsLlmActive()) {
    const j = lsLlmGet();
    return {
      ...A.text,
      provider: j.provider || A.text.provider,
      baseUrl: String(j.baseUrl).trim(),
      key: j.key || '',
      model: j.model || A.text.model
    };
  }
  return A.text;
}

/* Siap = model + (API key atau base URL proxy). Tidak ada lagi syarat toggle. */
function aiReady() {
  const c = aiCfg();
  if (!c.model) return false;
  if (!c.key && !c.baseUrl) return false;
  return true;
}

function apiErrMsg(data, status) {
  const m = (data && data.error && (data.error.message || data.error.status)) || (data && data.message) || '';
  if (m) return m;
  if (status === 401 || status === 403) return 'API key ditolak (' + status + ')';
  if (status === 404 || status === 405) return 'Endpoint tidak ada (' + status + ') — base URL atau jenis provider salah';
  if (status === 429) return 'Kena rate limit (429) — coba lagi sebentar';
  if (status >= 500) return 'Server provider sedang error (' + status + ')';
  return 'Permintaan gagal (' + status + ')';
}

/* --- transport LLM ---
   Dua hal yang bikin "Failed to fetch" padahal server proxy hidup:

   1. HOST. Chrome resolve "localhost" ke ::1 (IPv6) lebih dulu, sementara proxy
      lokal umumnya cuma listen di 127.0.0.1 (IPv4). Akibatnya koneksi ditolak
      dalam 0–1 ms dan muncul TypeError: Failed to fetch — terlihat seperti CORS
      padahal bukan. Jadi "localhost" selalu kita tulis ulang ke 127.0.0.1.

   2. PROTOKOL. Model gaya proxy ("ag/gemini-3.8-flash-low") tidak ada di endpoint
      resmi Google. Proxy seperti itu hampir selalu bicara /chat/completions,
      bukan :generateContent. Jadi protokol dipilih dari base URL, bukan dari
      nama provider — dan kalau salah tebak, kita coba jalur satunya. */

function normalizeBase(base) {
  let b = String(base || '').trim();
  if (!b) return b;
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b;
  b = b.replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/i, '');
  b = b.replace(/\/v1beta$/i, '');
  b = b.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, (m, p) => p + '127.0.0.1');
  b = b.replace(/^(https?:\/\/)\[::1\]/i, (m, p) => p + '127.0.0.1');
  return b;
}

function swapHost(base) {
  const b = String(base || '');
  if (!b) return '';
  if (/^https?:\/\/127\.0\.0\.1(?=[:/]|$)/i.test(b)) return b.replace(/^(https?:\/\/)127\.0\.0\.1/i, (m, p) => p + 'localhost');
  if (/^https?:\/\/localhost(?=[:/]|$)/i.test(b)) return b.replace(/^(https?:\/\/)localhost/i, (m, p) => p + '127.0.0.1');
  return '';
}

function llmProtocol(cfg) {
  if (cfg.provider !== 'gemini') return 'openai';
  const base = String(cfg.baseUrl || '').trim();
  if (!base) return 'gemini';                                   // endpoint resmi Google
  if (/generativelanguage\.googleapis\.com/i.test(base)) return 'gemini';
  return 'openai';                                              // proxy → OpenAI-compatible
}

function llmEndpoint(cfg, proto) {
  const p = proto || llmProtocol(cfg);
  if (p === 'gemini') return normalizeBase(cfg.baseUrl || AI_PRESETS.gemini.base) + '/v1beta/models/' + cfg.model + ':generateContent';
  return normalizeBase(cfg.baseUrl || AI_PRESETS.openai.base) + '/chat/completions';
}

/* --- pembaca balasan yang toleran ---
   Proxy / router LLM tidak selalu menjawab persis seperti dokumentasi. Yang
   sering bikin "Respons model kosong" padahal request sukses:

   a) proxy mengabaikan stream:false dan mengirim SSE ("data: {...}") → JSON.parse gagal;
   b) content dikirim sebagai array part: [{type:'text',text:'...'}];
   c) model reasoning menaruh jawaban di reasoning_content, content kosong;
   d) router meneruskan balasan gaya Gemini (candidates) atau Anthropic (content[]);
   e) content kosong karena kena max_tokens (finish_reason: 'length').

   Jadi: baca body sebagai teks dulu, baru coba JSON → SSE → teks mentah. */

function rawSnippet(v, n) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const max = n || 200;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return '';
  const flat = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(flat).join('');
    if (typeof v === 'object') {
      if (v.text != null) return flat(v.text);
      if (v.content != null) return flat(v.content);
      if (v.value != null) return flat(v.value);
      return '';
    }
    return '';
  };
  const ch = (data.choices || [])[0];
  if (ch) {
    const m = ch.message || ch.delta || {};
    const t = flat(m.content) || flat(m.reasoning_content) || flat(m.reasoning) || flat(ch.text) || flat(ch.content);
    if (t) return t;
  }
  const cand = (data.candidates || [])[0];
  if (cand && cand.content) {
    const t = flat(cand.content.parts);
    if (t) return t;
  }
  if (Array.isArray(data.content)) { const t = flat(data.content); if (t) return t; }
  const g = flat(data.output_text) || flat(data.text) || flat(data.response)
    || flat(data.result) || flat(data.output) || flat(data.message);
  if (g) return g;
  if (data.data) return extractText(data.data);
  return '';
}

function parseSSE(raw) {
  if (!/^\s*(data|event):/m.test(raw)) return null;
  let text = '';
  const fin = [];
  raw.split(/\r?\n/).forEach((line) => {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m) return;
    const payload = m[1].trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch (e) { return; }
    text += extractText(obj);
    const ch = (obj.choices || [])[0];
    if (ch && ch.finish_reason) fin.push(ch.finish_reason);
    if (obj.candidates && obj.candidates[0] && obj.candidates[0].finishReason) fin.push(obj.candidates[0].finishReason);
  });
  return { text: text.trim(), finish: fin.join(',') };
}

async function readLLMResponse(res) {
  const raw = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  const sse = data ? null : parseSSE(raw);
  return { raw, data, sse };
}

function pickText(data, sse, raw) {
  const fromSSE = sse && sse.text;
  if (fromSSE) return fromSSE;
  const fromJSON = extractText(data);
  if (fromJSON) return fromJSON;
  // body bukan JSON & bukan SSE: mungkin teks polos (bukan halaman HTML error)
  if (!data && raw && !/^\s*</.test(raw) && raw.trim()) return raw.trim();
  return '';
}

async function callGemini(cfg, system, user, signal) {
  const base = normalizeBase(cfg.baseUrl || AI_PRESETS.gemini.base);
  const url = base + '/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent'
    + (cfg.key ? '?key=' + encodeURIComponent(cfg.key) : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: Number(cfg.temp) || 0.9, maxOutputTokens: 8192 }
    })
  });
  const { raw, data, sse } = await readLLMResponse(res);
  if (!res.ok) {
    const err = new Error(apiErrMsg(data, res.status) + (data ? '' : ' · ' + (rawSnippet(raw, 160) || 'body kosong')));
    err.status = res.status;
    throw err;
  }
  const cand = ((data && data.candidates) || [])[0] || {};
  const text = pickText(data, sse, raw);
  if (!text) {
    const fr = cand.finishReason || (sse && sse.finish) || '';
    throw new Error('Model balas tanpa teks' + (fr ? ' (finishReason: ' + fr + ')' : '')
      + ' · balasan mentah: ' + (rawSnippet(raw, 200) || '(body kosong)'));
  }
  return text;
}

async function callOpenAI(cfg, system, user, signal) {
  const base = normalizeBase(cfg.baseUrl || AI_PRESETS.openai.base);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: Number(cfg.temp) || 0.9,
      max_tokens: 4096,
      stream: false
    })
  });
  const { raw, data, sse } = await readLLMResponse(res);
  if (!res.ok) {
    const err = new Error(apiErrMsg(data, res.status) + (data ? '' : ' · ' + (rawSnippet(raw, 160) || 'body kosong')));
    err.status = res.status;
    throw err;
  }
  const ch = ((data && data.choices) || [])[0] || {};
  const text = pickText(data, sse, raw);
  if (!text) {
    const fr = ch.finish_reason || (data && data.finish_reason) || (sse && sse.finish) || '';
    throw new Error('Model balas tanpa teks' + (fr ? ' (finish_reason: ' + fr + ')' : '')
      + ' · balasan mentah: ' + (rawSnippet(raw, 200) || '(body kosong)'));
  }
  return text;
}

const isNetFail = (e) => /Failed to fetch|NetworkError|Load failed|Network request failed/i.test(String(e && e.message));
const isRouteMiss = (e) => e && (e.status === 404 || e.status === 405
  || /not found|unknown|no route|cannot post|invalid url|endpoint tidak ada/i.test(String(e.message)));

async function callLLM(cfg, system, user, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  const proto = llmProtocol(cfg);
  const alt = proto === 'gemini' ? 'openai' : 'gemini';
  const attempt = (p, baseOverride) => {
    const c = baseOverride ? { ...cfg, baseUrl: baseOverride } : cfg;
    return p === 'gemini' ? callGemini(c, system, user, ctrl.signal) : callOpenAI(c, system, user, ctrl.signal);
  };
  try {
    try {
      return await attempt(proto);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (isNetFail(e)) {
        const swapped = swapHost(cfg.baseUrl || '');
        if (swapped) return await attempt(proto, swapped);   // coba host satunya (IPv6 ↔ IPv4)
        throw e;
      }
      if (isRouteMiss(e)) return await attempt(alt);          // tebakan protokol salah → jalur satunya
      throw e;
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout — provider tidak menjawab dalam ' + Math.round((timeoutMs || 60000) / 1000) + ' detik');
    if (isNetFail(e)) {
      const b = String(cfg.baseUrl || '');
      const local = /localhost|127\.0\.0\.1|\[::1\]/i.test(b);
      throw new Error(local
        ? 'Proxy lokal tidak bisa dihubungi (' + normalizeBase(b) + '). Pastikan server benar-benar jalan, port-nya cocok, dan tidak dipanggil dari https.'
        : 'Host tidak bisa dihubungi (' + normalizeBase(b || AI_PRESETS[cfg.provider] && AI_PRESETS[cfg.provider].base || '') + '). Cek base URL, koneksi, dan izin CORS server.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* --- bahan prompt --- */

/* nilai yang isinya cuma pengganti tempat ("Lihat deskripsi") tidak boleh
   ikut terkirim: model akan menganggapnya fakta dan menuliskannya apa adanya */
function briefValue(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^(-|–|—|n\/a|na|null|undefined|0)$/i.test(s)) return '';
  if (/deskripsi|lihat detail|selengkapnya|cek di|ada di toko/i.test(s) && s.length < 26) return '';
  return s;
}

/* baris "Label : isi" dari deskripsi seller — ini yang dulu dibuang total,
   padahal justru berisi ukuran, bahan, dan isi paket */
function specLines(item) {
  const d = item.detail || {};
  const out = [];
  const push = (s) => {
    const v = briefValue(String(s || '').replace(/\s+/g, ' ').trim());
    if (v.length < 4 || v.length > 72) return;
    if (/https?:|wa\.me|shopee\.co|tokopedia|tiktok\.com/i.test(v)) return;
    if (/^(note|catatan|nb)\b/i.test(v)) return;
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };
  String(d.specs || '').split('|').forEach(push);
  String(d.raw_description || '').split('\n').forEach((raw) => {
    const l = raw.replace(/^[\s•*\-–—✓~=>()\[\]]+/, '').replace(/[{}]/g, '').trim();
    if (!/[:：]/.test(l)) return;
    if (/(chat|admin|whatsapp|\bwa\b|order|pembelian|rekening|ongkir|alamat|resi)/i.test(l)) return;
    push(l);
  });
  return out.slice(0, 6);
}

/* kalimat asli dari deskripsi seller, dipakai supaya model punya bahan konkret
   selain klaim yang sudah disaring descBullets() */
/* Baris deskripsi seller yang memuat klaim terlarang tidak boleh ikut ke bahan
   prompt. Bukan karena Writer tidak diberi tahu — CLAIM_GUARD sudah melarangnya
   — tapi karena model cenderung menyalin kalimat yang disodorkan apa adanya.
   Kasus nyata: bullet seller "✓ Mengobati vertigo dan sakit kepala" disalin
   bulat-bulat ke naskah TikTok tiga iterasi berturut-turut, dan tiap iterasi
   ditolak R-02. Yang haram tidak boleh masuk dapur.
   Pola diambil dari RULEBOOK, bukan disalin, supaya aturan tetap satu sumber. */
function claimLine(line) {
  const rules = (window.RULEBOOK && window.RULEBOOK.rules) || [];
  const t = String(line || '');
  if (!t) return false;
  /* Hanya aturan kind "regex" — yang dilarang sekalipun penjual menyebutnya.
     Aturan "gated" (halal, BPOM, original, garansi) boleh dikutip kalau
     sumbernya menyebut, jadi baris seperti "legalitas: BPOM RI & halal MUI"
     tetap berguna sebagai bahan. */
  return rules.some((r) => r.kind === 'regex'
    && (r.patterns || []).some((p) => new RegExp(p, 'i').test(t)));
}

function descExcerpt(item) {
  const d = item.detail || {};
  const raw = String(d.raw_description || '').replace(/\r/g, '');
  if (!raw) return '';
  const noise = /https?:|chat admin|reseller|dropship|real\s?pict|follow|testimoni|no refund|klik link|cek ulasan|jangan lupa|harga boleh|semua produk|cara pembelian|proses beli|rekening|ongkir|wa\.me|whatsapp|^kami |^kita |pabrik|produksi sendiri|designer|profesional|grosir|distributor|^100%|garansi|bpom|sni|original|termurah|terlaris/i;
  const lines = raw.split('\n')
    .map((l) => l.replace(/^[\s•*\-–—✓~=>()\[\]]+/, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 18 && l.length <= 140 && !noise.test(l) && !claimLine(l) && /[a-zA-Z]/.test(l));
  if (!lines.length) return '';
  let s = '';
  for (const l of lines) {
    if ((s ? s + ' ' + l : l).length > 210) break;
    s = s ? s + ' ' + l : l;
  }
  return s.trim();
}

function productBrief(item) {
  const d = item.detail || {};
  const cat = catOf(item);
  const rows = [
    ['Nama produk', briefValue(item.name)],
    ['Harga', briefValue(item.priceText)],
    ['Terjual', briefValue(item.soldText)],
    ['Toko', briefValue(shopName(item))],
    ['Kategori', cat.label],
    ['Fitur utama', featuresOf(item).join('; ')]
  ];

  const specs = specLines(item);
  if (specs.length) rows.push(['Spesifikasi & ukuran', specs.join('; ')]);

  const vars = briefValue(d.variations);
  if (vars) rows.push(['Varian tersedia', vars]);

  const loc = briefValue(d.shop_location);
  if (loc) rows.push(['Dikirim dari', loc]);

  const excerpt = descExcerpt(item);
  const bullets = descBullets(item)
    .filter((l) => l.length >= 22)
    .filter((l) => !excerpt || excerpt.toLowerCase().indexOf(l.toLowerCase()) < 0)
    .slice(0, 3);
  if (bullets.length) rows.push(['Klaim di deskripsi seller', bullets.join('; ')]);
  if (excerpt) rows.push(['Cuplikan deskripsi asli', excerpt]);

  return rows.filter((r) => r[1]).map((r) => r[0] + ': ' + r[1]).join('\n');
}

/* contoh nada bicara: diambil dari bank kalimat yang bisa diedit di Pengaturan */
function fewShot(item, plot) {
  const slots = (PLOT_SLOTS[plot] || PLOT_SLOTS.p1).slice(0, 4);
  /* buang contoh yang bertentangan dengan data produk — kalau tidak, model
     bisa menyalin "tokonya bukan official store" padahal nama tokonya
     "Axegear Official Store" */
  const shop = shopName(item);
  const contradict = [];
  if (/official|resmi/i.test(shop)) contradict.push(/bukan\s+(toko\s+)?(official|resmi)/i);
  if (item.priceNum && item.priceNum >= 200000) contradict.push(/harga\s+receh|receh\s+banget|murah\s+bgt/i);

  const out = [];
  slots.forEach((sl) => {
    const arr = slotLines(item.category, sl.key);
    if (!arr.length) return;
    const line = tpl(arr[Math.abs(hash(item.key) + sl.key.length) % arr.length], item);
    if (contradict.some((re) => re.test(line))) return;
    out.push('- ' + line);
  });
  return out.join('\n');
}

/* Struktur per post.
   Tiap plot punya satu pembuka, tiga babak tengah, dan satu penutup. Jumlah
   post menentukan berapa babak tengah yang dipakai: 5 post = satu babak satu
   post, 4 post = dua babak digabung, 3 post = ketiga babak jadi satu post.
   Dengan cara ini isi tetap sama, cuma kepadatannya yang menyesuaikan. */
const PLOT_ACTS = {
  p1: {
    open: 'Masalah kecil yang relatable dan bikin orang mikir "ini gue banget". Sebut produknya baru di dua kalimat terakhir, pakai nama dan harganya apa adanya.',
    middle: [
      'Bedah klaim seller: mana yang masuk akal, mana yang cuma bahasa iklan. Akui satu kekurangan nyata tanpa dibela atau dibalikin jadi pujian.',
      'Realita pemakaian harian: satu detail kecil yang baru ketahuan setelah dipakai beberapa hari, bukan yang kelihatan di foto.',
      'Alasan psikologis kenapa orang tetap beli barang ini meski sudah tahu kekurangannya.'
    ],
    close: 'Balik ke produknya tanpa jualan keras. Tutup dengan satu pertanyaan yang bikin orang mau cerita pengalamannya sendiri.'
  },
  p2: {
    open: 'Aku awalnya ngeremehin produk ini, dan sebutkan alasan skeptisnya dengan spesifik.',
    middle: [
      'Momen kepepet yang akhirnya bikin beli: tempat, waktu, atau kejadian yang konkret — bukan "karena butuh".',
      'Apa yang bikin kemakan: bandingkan dugaan awal dengan yang ternyata didapat setelah dipakai.',
      'Kekurangan yang tetap ada dan tidak hilang meski produknya kepakai.'
    ],
    close: 'Akui ini bukan barang untuk semua orang, lalu sebutkan siapa yang paling cocok. Tutup dengan satu pertanyaan singkat.'
  },
  p3: {
    open: 'Ada pekerjaan receh yang nggak pernah dihitung: mikir, milih, bolak-balik, atau ngulang kerjaan yang sama.',
    middle: [
      'Hitung kerugiannya dalam waktu dan uang, pakai angka yang wajar dan bisa dibayangkan pembaca.',
      'Bandingkan hitungan itu dengan harga produknya, lalu sebutkan dalam berapa lama hitungan ini balik modal.',
      'Batas di mana hitungan ini masuk akal: kalau pemakaiannya sesekali, hitungan ini jadi tidak berlaku.'
    ],
    close: 'Sebutkan kekurangan produknya dengan jujur, lalu tutup dengan satu pertanyaan singkat.'
  },
  p4: {
    open: 'Ada dua kubu kebiasaan yang berlawanan, dan sebutkan masing-masing dengan contoh nyata.',
    middle: [
      'Dua-duanya nggak ideal: sebutkan ongkos yang ditanggung masing-masing kubu.',
      'Jalan tengah lewat produk ini, dijelaskan sebagai kompromi — bukan sebagai jawaban paling benar.',
      'Bukti fisik yang bisa dicek sendiri sebelum beli: bahan, ukuran, atau bagian yang gampang dilihat.'
    ],
    close: 'Bilang terus terang produk ini condong ke kubu mana, lalu tutup dengan satu pertanyaan singkat.'
  }
};

function plotBrief(plot, parts) {
  const A = PLOT_ACTS[plot] || PLOT_ACTS.p1;
  const n = Math.max(3, Math.min(5, parts || 3));
  const mid = A.middle.slice();
  while (mid.length > n - 2) {
    const i = mid.length - 2;
    mid.splice(i, 2, mid[i].replace(/[.\s]+$/, '') + '. ' + mid[i + 1]);
  }
  const out = ['Post 1: ' + A.open];
  mid.forEach((m, i) => out.push('Post ' + (i + 2) + ': ' + m));
  out.push('Post ' + n + ' (terakhir): ' + A.close);
  return out.join('\n');
}

/* sudut pandang ringkas untuk paket TikTok (satu paragraf, bukan per post) */
const PLOT_ANGLE = {
  p1: 'Sudut: bedah klaim produk dengan jujur — mana yang benar, mana yang cuma bahasa iklan, dan kenapa orang tetap beli.',
  p2: 'Sudut: aku yang awalnya skeptis, lalu kepepet dan akhirnya beli. Ceritakan apa yang bikin kemakan.',
  p3: 'Sudut: hitung pekerjaan receh yang nggak pernah dihitung, lalu bandingkan dengan harga produknya.',
  p4: 'Sudut: dua kubu kebiasaan yang berlawanan, dua-duanya nggak ideal, dan produk ini sebagai jalan tengah.'
};

/* proseLo/proseHi = jatah karakter untuk badan utas SAJA.
   Blok link afiliasi (~180 karakter) ditambahkan aplikasi di akhir, jadi kalau
   tidak dikurangi dari target, model menulis 1290–1455 lalu link masuk dan
   totalnya jadi 1470–1630 — persis di celah yang tidak bisa dipecah jadi 3
   post (maks 1500) maupun 4 post (min 1720). */
/* Dua larangan ini lahir dari kasus nyata: produk herbal BPOM yang deskripsinya
   menulis "Untuk pengobatan: 3x2 kapsul", lalu Writer menyalin frasa itu dan
   menambah klaim garansi yang tidak ada di sumber. Reviewer memblokir 3 iterasi
   berturut-turut dan pipeline berhenti. Aturannya sudah ada di rulebook, tapi
   Writer tidak pernah diberi tahu — jadi diberi tahu di sini. */
const CLAIM_GUARD = [
  '- Dilarang memakai kata klaim kesehatan: sembuh, menyembuhkan, mengobati, obat, ampuh, manjur, terapi, pengobatan. Kalau data produk memuat frasa itu, parafrase jadi aturan pakai: "diminum 3x2 kapsul sehari sesudah makan". Sebut produk dengan mereknya, bukan kata "obat".',
  '- Dilarang menempelkan kata kerja klaim (mengatasi, meredakan, menghilangkan, mengurangi, mengobati, menyembuhkan) pada nama penyakit atau keluhan (vertigo, migrain, pusing, sakit kepala, asam urat, kolesterol, lambung, dan sejenisnya). Ini berlaku juga saat klaim itu dikutip dari penjual atau dilembutkan: "katanya bisa mengatasi vertigo", "banyak yang bilang ampuh untuk migrain", "dulu dipakai untuk sakit kepala" — semuanya tetap klaim. Boleh menyebut keluhan tanpa kata kerja klaim: "buat yang sering pusing di jam kerja".',
  '- Jangan menyebut garansi, jaminan, terjamin, uang kembali, atau ganti rugi kecuali frasa itu tertulis persis di data produk. "Terjamin aman" tetap janji, sekalipun penjual menyebut kata "aman".'
];

function threadSystem(parts, proseLo, proseHi) {
  const p = parts || 3;
  return [
    'Kamu penulis konten afiliasi Shopee yang menulis di Threads.',
    'Bahasa Indonesia, gaya ngobrol santai seperti orang beneran bercerita — bukan copywriter iklan.',
    '',
    'BENTUK OUTPUT:',
    `- Tulis SATU utas utuh. Utas ini nanti dipotong otomatis jadi TEPAT ${p} post.`,
    `- Total ${proseLo} sampai ${proseHi} karakter. Ini belum termasuk link afiliasi yang ditambahkan otomatis di akhir, jadi jangan menyisakan tempat untuk link.`,
    `- Patuhi batas itu. Kalau kurang, utasnya jadi terlalu pendek; kalau lebih, tidak muat dibagi jadi ${p} post.`,
    '- Tiap post berisi 2 sampai 3 paragraf pendek.',
    '- Satu kalimat maksimal 140 karakter (sekitar 20–25 kata). Kalimat yang kepanjangan pecah jadi dua kalimat.',
    '- Antar paragraf cukup SATU baris baru. Jangan menyisipkan baris kosong ganda.',
    '',
    'ATURAN WAJIB:',
    '- Jangan pakai bullet, numbering, heading, atau garis pemisah seperti "-----".',
    '- Jangan menulis label "Post 1", "Post 2", dan sejenisnya. Tulis mengalir saja.',
    '- Maksimal 2 emoji untuk seluruh utas.',
    '- Dilarang memakai kalimat jualan klise: "wajib punya", "buruan", "harga spesial", "kualitas terjamin", "recommended banget".',
    '- Jangan mengarang fakta. Hanya pakai data produk yang diberikan. Kalau sebuah detail tidak ada di data, jangan sebut.',
    ...CLAIM_GUARD,
    '- Sebut angka (harga, ukuran, jumlah) hanya kalau angkanya memang ada di data produk.',
    '- Setiap kalimat harus utuh dan bisa berdiri sendiri. Jangan menggantung kalimat yang lanjutannya baru ada di post berikutnya.',
    '- JANGAN menulis link apa pun. Link afiliasi ditambahkan otomatis di akhir.',
    '- Post terakhir ditutup dengan satu pertanyaan singkat yang memancing orang berkomentar.',
    '- Output hanya teks utasnya. Tanpa pembuka, tanpa penjelasan.'
  ].join('\n');
}

function threadUser(item, plot, parts, proseLo, proseHi) {
  const p = parts || 3;
  return [
    'DATA PRODUK',
    productBrief(item),
    '',
    'CONTOH NADA BICARA (tiru suaranya, jangan salin kalimatnya):',
    fewShot(item, plot) || '- santai, jujur, sedikit self-deprecating',
    '',
    'STRUKTUR ' + p + ' POST',
    plotBrief(plot, p),
    '',
    `Target panjang badan utas: ${proseLo} sampai ${proseHi} karakter (belum termasuk link).`,
    'Tulis utasnya sekarang.'
  ].join('\n');
}

/* --- pembersih output --- */
function splitParagraphs(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/^[-–—•*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((s) => s && !/^-{3,}$/.test(s));
}

function trimEmoji(text, max) {
  const re = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
  let seen = 0;
  return String(text).replace(re, (m) => (++seen > max ? '' : m)).replace(/[ \t]{2,}/g, ' ').trim();
}

function lastNeedsQuestion(posts) {
  const last = posts[posts.length - 1] || '';
  return !/\?/.test(last);
}

/* Post yang isinya satu blok panjang tanpa jeda baris sulit dibaca. Sisipkan
   SATU baris baru di batas kalimat yang paling dekat tengah. Panjang total
   tidak berubah karena spasi diganti newline, dan kalimat tidak dipotong. */
function ensureParaBreak(post, minLen) {
  const t = String(post || '');
  if (t.indexOf('\n') >= 0 || t.length < (minLen || 260)) return t;
  const target = t.length / 2;
  let best = -1, bestD = Infinity;
  const re = /[.!?…]["'”’)\]]?\s/g;
  let m;
  while ((m = re.exec(t))) {
    const at = m.index + m[0].length - 1;      // posisi spasi sesudah tanda baca
    if (at <= 0 || at >= t.length - 1) continue;
    const d = Math.abs(at - target);
    if (d < bestD) { bestD = d; best = at; }
  }
  if (best < 0) return t;
  return t.slice(0, best) + '\n' + t.slice(best + 1);
}

/* --- generator LLM ---
   `opts.brief`  = brief dari Planner (batas fakta & klaim)
   `opts.revise` = daftar pelanggaran dari Reviewer saat draf ditolak
   Keduanya disisipkan ke pesan pengguna, bukan ke system prompt: Writer
   harus tetap melihat instruksi dasarnya utuh, dan revisi menempel di
   dekat bahan yang harus diperbaiki. */
async function llmThreads(item, opts) {
  const brief = (opts && opts.brief) || '';
  const revise = (opts && opts.revise) || '';
  const cfg = aiCfg();
  const parts = threadParts(item);
  const plot = plat(item, 'threads').plot || item.plot;

  /* Anggaran karakter dihitung untuk SELURUH utas (badan + link), lalu jatah
     badan = total dikurangi blok link yang ditambahkan aplikasi di akhir. */
  const linkBeat = linkCurious(item);
  const linkLen = String(linkBeat.t || '').length + 1;

  const proseLo = Math.max(80, parts * POST_TARGET_LO - linkLen);
  const proseHi = Math.max(proseLo + 40, parts * POST_TARGET_HI - linkLen);

  const sys = () => threadSystem(parts, proseLo, proseHi);
  const usr = () => threadUser(item, plot, parts, proseLo, proseHi) + brief + revise;

  /* satu percobaan: teks mentah -> post siap pakai */
  const attempt = (text) => {
    const paras = splitParagraphs(text);
    const joined = paras.join(' ');
    if (!paras.length || joined.length < 300) return null;

    const beats = paras.map((p) => ({ t: p }));
    if (lastNeedsQuestion([joined])) {
      const q = slotLines(item.category, 'questions');
      if (q.length) beats.push({ t: q[Math.abs(hash(item.key)) % q.length] });
    }
    beats.push(linkBeat);

    const posts = rebalancePosts(mergeToMax(packThread(beats, item), 5, POST_MAX_CHARS),
      POST_PREF_CHARS, POST_MAX_CHARS, POST_MIN_CHARS);
    if (!posts.length) return null;
    return { posts: posts.map((p) => ensureParaBreak(p, 260)), total: joined.length };
  };

  /* Hasil dinilai dari kenyataan pemecahannya, bukan dari panjang target.
     Dulu retry dipicu oleh selisih panjang saja, sehingga utas yang sebenarnya
     sudah bisa dipecah rapi tetap ditulis ulang — dan hasil ulangannya justru
     lebih sulit dipecah. */
  const fits = (r) => !!r && r.posts.length >= 3 &&
    r.posts.every((p) => p.length >= POST_MIN_CHARS && p.length <= POST_MAX_CHARS);
  const score = (r) => (!r ? -1 : (fits(r) ? 100000 : 0) + Math.min.apply(null, r.posts.map((p) => p.length)));

  const first = attempt(await callLLM(cfg, sys(), usr(), 150000));
  if (!first) throw new Error('Model tidak mengirim teks yang bisa dipakai');
  if (fits(first)) return first.posts.map((p) => trimEmoji(p, 2));

  /* belum pas: minta sekali lagi, dengan arahan sesuai masalah sebenarnya */
  const tooShort = first.total + linkLen < parts * POST_MIN_CHARS;
  const note = tooShort
    ? `\n\nCATATAN: percobaan sebelumnya terlalu pendek (${first.total} karakter). ` +
      `Tulis ulang ${proseLo + 30} sampai ${proseHi} karakter badan utas. ` +
      'Tambah detail konkret dari data produk, jangan menambah kalimat kosong.'
    : `\n\nCATATAN: percobaan sebelumnya (${first.total} karakter) tidak bisa dipecah rapi jadi ${parts} post. ` +
      `Tulis ulang dengan panjang ${proseLo} sampai ${proseLo + 80} karakter badan utas. ` +
      'Kalimat tetap pendek dan utuh, buang kalimat yang mengulang.';

  const second = attempt(await callLLM(cfg, sys(), usr() + note, 150000));
  if (score(second) > score(first)) return second.posts.map((p) => trimEmoji(p, 2));
  return first.posts.map((p) => trimEmoji(p, 2));
}

function parseJSONLoose(text) {
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
}

function tiktokSystem() {
  return [
    'Kamu perencana konten afiliasi Shopee untuk TikTok.',
    'Bahasa Indonesia, gaya santai dan konkret.',
    'Balas HANYA dengan satu objek JSON valid, tanpa penjelasan dan tanpa code fence.',
    'Skema: {"hook": string, "scenes": string[], "caption": string, "hashtags": string[], "coverText": string, "music": string}',
    '- hook: kalimat pembuka video, maksimal 90 karakter.',
    '- scenes: 4 sampai 6 adegan, tiap adegan satu kalimat instruksi visual yang bisa direkam.',
    '- caption: maksimal 300 karakter, tanpa hashtag, tanpa URL. Akhiri dengan penanda afiliasi singkat — tulis "link di bio · afiliasi" di kalimat terakhir.',
    '- hashtags: 4 sampai 6 tag tanpa tanda #.',
    '- coverText: maksimal 28 karakter.',
    '- music: saran jenis musik/beat.',
    'Jangan mengarang fakta di luar data produk.',
    ...CLAIM_GUARD
  ].join('\n');
}

function tiktokUser(item) {
  return [
    'DATA PRODUK',
    productBrief(item),
    '',
    'SUDUT PANDANG',
    PLOT_ANGLE[item.plot] || PLOT_ANGLE.p1,
    '',
    'Buat paket konten TikTok-nya sekarang dalam format JSON.'
  ].join('\n');
}

async function llmTiktok(item, opts) {
  const brief = (opts && opts.brief) || '';
  const revise = (opts && opts.revise) || '';
  const cfg = aiCfg();
  const raw = await callLLM(cfg, tiktokSystem(), tiktokUser(item) + brief + revise, 150000);
  const o = parseJSONLoose(raw);
  const scenes = Array.isArray(o.scenes) ? o.scenes.map(String).filter(Boolean).slice(0, 6) : [];
  if (!o.hook || !scenes.length) throw new Error('Struktur JSON tidak lengkap');
  return {
    hook: String(o.hook).slice(0, 120),
    scenes,
    caption: String(o.caption || '').slice(0, 300),
    hashtags: (Array.isArray(o.hashtags) ? o.hashtags : []).map((h) => String(h).replace(/^#/, '')).slice(0, 6),
    coverText: String(o.coverText || '').slice(0, 28),
    music: String(o.music || 'Trending sound'),
    duration: '0:20–0:30',
    status: plat(item, 'tiktok').status,
    updatedAt: Date.now()
  };
}

/* --- antrean generate ---
   Semua jalur generate lewat sini. Tidak ada fallback template: kalau model
   gagal, konten lama dibiarkan apa adanya dan error-nya disimpan per item.
   Dengan begitu tidak ada lagi konten "template" yang menyamar jadi hasil LLM. */
async function generateFor(pf, list, onProgress) {
  const cfg = aiCfg();
  let ok = 0, failed = 0, lastErr = '';
  const gagal = [];
  for (let n = 0; n < list.length; n++) {
    const it = list[n];
    if (onProgress) onProgress(n + 1, list.length, it);
    try {
      /* Satu draf = satu putaran Planner → Writer → Reviewer. Pipeline
         mengembalikan draf final, transkrip lengkap, dan putusan Reviewer.
         Yang disimpan bukan cuma hasilnya, tapi alasan di baliknya. */
      const liveKey = it.key + '|' + pf;
      _agentLive.set(liveKey, { step: null, iter: 1, startedAt: Date.now(), done: [] });
      agentTickStart();
      paintAgentLive(it.key, pf);

      const run = await runAgentPipeline(pf, it, (step, phase, info) => {
        const st = _agentLive.get(liveKey);
        if (!st) return;
        if (phase === 'start') { st.step = step; st.iter = info.iter || 1; }
        else {
          st.done.push({ step, iter: info.iter || 0, ms: info.ms || 0 });
          st.step = null;
        }
        paintAgentLive(it.key, pf);
      });
      _agentLive.delete(liveKey);

      if (pf === 'threads') plat(it, 'threads').posts = run.draft.posts;
      else Object.assign(plat(it, 'tiktok'), run.draft);
      const p = plat(it, pf);
      p.source = 'llm';
      p.model = cfg.provider + '/' + cfg.model;
      p.status = 'belum review';
      p.error = '';
      p.updatedAt = Date.now();
      p.review = run.review;
      p.trace = run.trace;
      if (run.review.state === 'escalated') {
        log('warn', `${String(it.name).slice(0, 30)}… ${pf}: 3 iterasi habis, masih melanggar — diserahkan ke manusia`);
      }
      ok++;
    } catch (e) {
      failed++;
      lastErr = e.message || String(e);
      _agentLive.delete(it.key + '|' + pf);
      const p = plat(it, pf);
      p.error = lastErr;
      p.updatedAt = Date.now();
      gagal.push(it.name);
    }
    save();
    if (n < list.length - 1) await new Promise((r) => setTimeout(r, 700));
  }
  /* Filter "Belum dibuat" menyembunyikan produk begitu drafnya jadi — hasil
     generate seolah tidak muncul. Pindah ke "Semua" supaya hasilnya kelihatan. */
  let moved = false;
  if (ok && S.ui.view === 'review' && S.ui.reviewFilter === 'kosong') {
    S.ui.reviewFilter = 'semua';
    moved = true;
    log('info', 'Filter "Belum dibuat" dipindah ke "Semua" supaya hasil generate kelihatan');
  }
  return { ok, failed, lastErr, total: list.length, gagal, moved };
}

function aiCard() {
  const c = aiCfg();
  const ready = aiReady();
  const preset = AI_PRESETS[c.provider] || AI_PRESETS.gemini;
  return `
  <div class="card mb14">
    <div class="card-head">
      <h3>Generator LLM</h3>
      <span class="badge ${ready ? 'b-ok' : ''}">${ready ? 'siap dipakai' : 'belum diisi'}</span>
    </div>
    <div class="card-body">
      ${!(SERVER_LLM && SERVER_LLM.configured) && lsLlmActive() ? `<div class="hint warn mb14">
        <b>Tidak dipakai.</b> Browser ini sedang memakai setelan <b>“LLM di komputer ini”</b>.
        Matikan di kartu bawah kalau ingin kembali ke setelan ini.
      </div>` : ''}
      <div class="hint mb14">
        Satu konfigurasi untuk semua teks — <b>Threads dan TikTok</b> memakai model yang sama.
        Setiap <b>Generate</b> selalu lewat LLM ini; tidak ada lagi mode template, jadi hasilnya
        tidak pernah tertukar. Bank kalimat di kartu bawah dipakai sebagai <b>contoh nada bicara</b>.
      </div>

      ${SERVER_LLM ? `<div class="hint mt14" style="border-color:#b8d4f0">
        <b>LLM diurus server.</b> Model <code>${esc(SERVER_LLM.model || '-')}</code> dipanggil lewat
        <code>/api/llm</code>, dan API key-nya disimpan di berkas <code>.env</code> di server —
        tidak pernah dikirim ke browser. Kolom di bawah sengaja dimatikan selama mode ini aktif;
        mengisinya tidak akan berpengaruh apa pun.
      </div>` : ''}

      <div class="grid-2">
        <div class="field">
          <div class="field-label"><span>Provider</span></div>
          <select class="select" data-ai="provider" style="max-width:none;width:100%"${SERVER_LLM ? ' disabled' : ''}>
            ${Object.keys(AI_PRESETS).map((k) => `<option value="${k}"${k === c.provider ? ' selected' : ''}>${AI_PRESETS[k].label}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <div class="field-label"><span>Model</span></div>
          <input class="input" data-ai="model" value="${esc(c.model)}" list="aim-text" placeholder="nama model"${SERVER_LLM ? ' disabled' : ''}>
          <datalist id="aim-text">${(preset.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
        </div>
      </div>

      <div class="field mt14">
        <div class="field-label"><span>API key</span></div>
        <input class="input" type="password" data-ai="key" value="${esc(c.key)}" placeholder="${SERVER_LLM ? 'diurus server — tidak perlu diisi' : 'tempel API key'}" autocomplete="off"${SERVER_LLM ? ' disabled' : ''}>
      </div>

      <div class="field mt14">
        <div class="field-label"><span>Base URL <span class="tiny muted">— opsional, isi kalau lewat proxy</span></span></div>
        <input class="input" data-ai="baseUrl" value="${esc(c.baseUrl)}" placeholder="${esc(preset.base || 'https://proxy-kamu.dev')}"${SERVER_LLM ? ' disabled' : ''}>
        ${/localhost|\[::1\]/i.test(c.baseUrl || '')
          ? `<div class="tiny muted mt8">Otomatis dipanggil sebagai <code>${esc(normalizeBase(c.baseUrl))}</code> — Chrome sering resolve <code>localhost</code> ke IPv6 (<code>::1</code>) padahal proxy lokal cuma listen di IPv4.</div>`
          : `<div class="tiny muted mt8">Diisi = lewat proxy (OpenAI-compatible). Kosong = langsung ke provider resmi.</div>`}
      </div>

      <div class="row mt14">
        <button class="btn btn-sm" style="background:#f6f7f9" data-act="ai-test">Tes koneksi</button>
        <span class="tiny muted" data-aitest></span>
      </div>

      ${ready ? '' : `<div class="hint warn mt14">
        Belum lengkap: isi <b>model</b> dan <b>API key</b> (atau Base URL proxy). Selama belum lengkap,
        tombol Generate dimatikan supaya tidak ada konten yang dibuat tanpa LLM.
      </div>`}

      ${SERVER_LLM ? `<div class="hint mt14">
        Tidak ada API key di browser maupun di database untuk mode ini. Yang dipakai adalah
        <code>LLM_API_KEY</code> di <code>.env</code> server, dibaca hanya oleh proses Python.
      </div>` : `<div class="hint warn mt14">
        API key tersimpan di <code>data/affiliate.db</code> dan terkirim dari browser saat generate.
        Aman untuk laptop pribadi. Kalau app ini di-hosting, kunci diredaksi untuk pengunjung luar,
        tapi tetap lebih baik mengisi <b>Base URL</b> ke proxy milikmu.
      </div>`}
      <div class="row mt14">
        <button class="btn btn-primary" data-act="ai-gen" data-pf="threads">Generate Threads</button>
        <button class="btn btn-primary" data-act="ai-gen" data-pf="tiktok">Generate TikTok</button>
        <button class="btn btn-danger" data-act="ai-clear">Hapus API key</button>
      </div>
    </div>
  </div>`;
}

/* ---- kartu LLM lokal (setelan ada di browser, bukan di database) ---- */
function llmLokalCard() {
  /* Kalau server sudah menyediakan LLM, kartu ini tidak ditampilkan sama
     sekali. Menyimpan key di localStorage terbukti tidak stabil antar
     browser, dan pengunjung tidak seharusnya mengurus key sendiri. */
  if (SERVER_LLM && SERVER_LLM.configured) return '';
  const j = lsLlmGet() || {};
  const on = lsLlmActive();
  const base = j.baseUrl || 'http://127.0.0.1:20128/v1';
  const model = j.model || 'ag/gemini-3.8-flash-low';
  return `
  <div class="card mb14">
    <div class="card-head">
      <h3>LLM di komputer ini</h3>
      <span class="badge ${on ? 'b-ok' : ''}">${on ? 'aktif' : 'belum diisi'}</span>
    </div>
    <div class="card-body">
      <div class="hint mb14">
        Semua permintaan LLM memakai setelan ini. Tersimpan di <b>browser ini saja</b>
        (localStorage): tidak masuk database, tidak terlihat pengunjung lain, dan tidak
        pernah dikirim ke server. Endpoint harus <b>OpenAI-compatible</b> dan bisa diakses
        lewat HTTPS — alamat <code>localhost</code> diblokir browser pada halaman publik.
      </div>
      <div class="row mb14">
        <label class="chk"><input type="checkbox" ${on ? 'checked' : ''} data-act="ls-llm-toggle"> Pakai LLM di komputer ini</label>
      </div>
      <div class="field">
        <div class="field-label"><span>Base URL</span></div>
        <input class="input" data-ls="baseUrl" value="${esc(base)}"${on ? '' : ' disabled'}>
      </div>
      <div class="field mt14">
        <div class="field-label"><span>API key</span></div>
        <input class="input" type="password" data-ls="key" value="${esc(j.key || '')}" placeholder="key gateway lokal" autocomplete="off"${on ? '' : ' disabled'}>
      </div>
      <div class="field mt14">
        <div class="field-label"><span>Model</span></div>
        <input class="input" data-ls="model" value="${esc(model)}" list="ls-model-list" autocomplete="off"${on ? '' : ' disabled'}>
        <datalist id="ls-model-list"></datalist>
      </div>
      <div class="row mt14">
        <button class="btn btn-sm" data-act="ls-fetch-models"${on ? '' : ' disabled'}>Ambil daftar model</button>
        <button class="btn btn-sm" data-act="ls-llm-test"${on ? '' : ' disabled'}>Tes koneksi</button>
        <button class="btn btn-sm" data-act="ls-llm-clear"${on ? '' : ' disabled'}>Hapus setelan lokal</button>
        <span class="tiny muted" data-lstest></span>
      </div>
      ${on ? `<div class="hint mt14">
        Chrome 142+ menampilkan izin <b>“akses jaringan lokal”</b> saat pertama kali dipakai — pilih
        <b>Allow</b>. Tanpa izin itu permintaannya diblokir, dan halaman ini tidak bisa menembusnya.
      </div>` : ''}
    </div>
  </div>`;
}

async function testLlmLokal() {
  const box = document.querySelector('[data-lstest]');
  const j = lsLlmGet() || {};
  const base = String(j.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) { if (box) box.textContent = 'Base URL belum diisi.'; return; }
  if (box) box.textContent = 'menguji…';
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(j.key ? { Authorization: 'Bearer ' + j.key } : {})
      },
      body: JSON.stringify({
        model: j.model || 'ag/gemini-3.8-flash-low',
        messages: [{ role: 'user', content: 'Balas satu kata: siap' }],
        max_tokens: 16,
        stream: false
      })
    });
    if (!r.ok) { if (box) box.textContent = 'Gagal: HTTP ' + r.status; return; }
    const d = await r.json();
    const m = ((d.choices || [])[0] || {}).message || {};
    if (box) box.textContent = 'Tersambung — balasan: ' + JSON.stringify(String(m.content || '').slice(0, 40));
  } catch (e) {
    if (box) box.textContent = 'Gagal: ' + ((e && e.message) || e) + ' — kemungkinan izin “akses jaringan lokal” belum diberikan.';
  }
}

/* Ambil daftar model untuk kartu Pengaturan. Membaca setelan yang sudah
   tersimpan di localStorage, karena field-nya menulis ke sana saat diketik. */
async function fetchLsModels(btn) {
  const j = lsLlmGet() || {};
  const box = document.querySelector('[data-lstest]');
  if (btn) btn.disabled = true;
  if (box) box.textContent = 'mengambil daftar model…';
  const r = await fetchModels(j.baseUrl, j.key);
  if (btn) btn.disabled = false;
  if (!r.ok) { if (box) box.textContent = r.message; return; }
  fillModelList(r.models, 'ls-model-list');
  const inp = document.querySelector('[data-ls="model"]');
  if (inp && !String(inp.value || '').trim()) {
    inp.value = r.models[0];
    j.model = r.models[0];
    lsLlmSet(j);
  }
  if (box) box.textContent = r.models.length + ' model ditemukan — pilih di kolom Model.';
}

/* Popup penyiapan: muncul untuk setiap pengunjung yang browser-nya belum
   punya setelan LLM, dan database juga tidak menyimpan kunci. */
/* Menguji endpoint OpenAI-compatible sebelum disimpan. Sengaja tidak menyimpan
   konfigurasi yang belum terbukti bisa dipanggil: lebih baik gagal di sini
   dengan pesan jelas daripada gagal di tengah pipeline 3 agen. */
async function probeLlm(baseUrl, key, model) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, message: 'Base URL wajib diisi.' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: 'Base URL harus diawali https:// atau http://' };
  if (location.protocol === 'https:' && /^http:\/\//i.test(base)) {
    return { ok: false, message: 'Halaman ini HTTPS, jadi endpoint http:// diblokir browser. Pakai https://, atau buka aplikasi lewat http://127.0.0.1:8787.' };
  }
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : {})
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Balas satu kata: siap' }],
        max_tokens: 16,
        stream: false
      })
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Key ditolak (HTTP ' + r.status + '). Periksa apakah key-nya benar dan masih aktif.' };
    if (r.status === 404) return { ok: false, message: 'Endpoint atau model tidak ditemukan (404). Cek Base URL dan nama model.' };
    if (r.status === 429) return { ok: false, message: 'Kuota atau batas laju habis (429). Coba lagi nanti atau pakai key lain.' };
    if (!r.ok) return { ok: false, message: 'Endpoint menjawab HTTP ' + r.status + '.' };
    const d = await r.json();
    const txt = (((d.choices || [])[0] || {}).message || {}).content;
    if (!txt) return { ok: false, message: 'Tersambung, tapi balasannya kosong. Biasanya nama model salah.' };
    return { ok: true, sample: String(txt).slice(0, 40) };
  } catch (e) {
    return { ok: false, message: 'Tidak bisa menghubungi endpoint. Kemungkinan alamatnya salah, atau penyedia menolak akses dari browser (CORS).' };
  }
}

/* Mengambil daftar model dari penyedia (GET {base}/models — bentuk OpenAI).
   Toleran terhadap beberapa bentuk balasan karena tidak semua proxy sama. */
async function fetchModels(baseUrl, key) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, message: 'Isi Base URL dulu.' };
  if (location.protocol === 'https:' && /^http:\/\//i.test(base)) {
    return { ok: false, message: 'Halaman ini HTTPS, jadi endpoint http:// diblokir browser.' };
  }
  try {
    const r = await fetch(base + '/models', {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      cache: 'no-store'
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Key ditolak saat mengambil daftar model (HTTP ' + r.status + ').' };
    if (!r.ok) return { ok: false, message: 'Daftar model tidak bisa diambil (HTTP ' + r.status + '). Isi nama model manual.' };
    const d = await r.json();
    const arr = Array.isArray(d) ? d
      : (Array.isArray(d.data) ? d.data
        : (Array.isArray(d.models) ? d.models : []));
    const ids = arr
      .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model)) || ''))
      .filter(Boolean);
    if (!ids.length) return { ok: false, message: 'Endpoint menjawab, tapi daftar modelnya kosong. Isi manual.' };
    return { ok: true, models: ids.sort() };
  } catch (e) {
    return { ok: false, message: 'Tidak bisa mengambil daftar model (CORS atau alamat salah). Isi nama model manual.' };
  }
}

function fillModelList(ids, listId) {
  const dl = document.getElementById(listId || 'setup-model-list');
  if (!dl) return;
  dl.innerHTML = ids.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

/* Daftar model bisa berisi ratusan nama (OpenRouter: 460). Mengambil yang
   pertama menurut abjad akan memilih model acak, jadi utamakan yang lazim. */
function pickModel(ids) {
  const PREFER = ['gpt-4o-mini', 'gpt-4.1-mini', 'gemini-2.5-flash', 'deepseek-chat', 'llama-3.3-70b-versatile', 'gpt-4o'];
  for (const p of PREFER) {
    const exact = ids.find((m) => m === p);
    if (exact) return exact;
  }
  for (const p of PREFER) {
    const suff = ids.find((m) => m.endsWith('/' + p));
    if (suff) return suff;
  }
  return ids[0];
}

async function fetchModelsToUi(btn) {
  const msg = document.querySelector('[data-setup-msg]');
  const base = (document.getElementById('setup-base') || {}).value || '';
  const keyEl = document.getElementById('setup-key');
  const key = keyEl ? keyEl.value.trim() : '';
  const inp = document.getElementById('setup-model');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = 'mengambil daftar model…';
  const r = await fetchModels(base, key);
  if (btn) btn.disabled = false;
  if (!r.ok) { if (msg) msg.textContent = r.message; return; }
  fillModelList(r.models);
  if (inp && !inp.value.trim()) inp.value = pickModel(r.models);
  if (msg) msg.textContent = r.models.length + ' model ditemukan — pilih di kolom Model.';
}

async function saveLlmSetup(btn) {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const msg = document.querySelector('[data-setup-msg]');
  const provider = (document.getElementById('setup-provider') || {}).value || 'openai';
  const baseUrl = val('setup-base');
  const key = val('setup-key');
  let model = val('setup-model');

  if (!baseUrl) { if (msg) msg.textContent = 'Base URL wajib diisi.'; return; }
  if (!key && provider !== 'custom') { if (msg) msg.textContent = 'API key wajib diisi untuk penyedia publik.'; return; }

  if (btn) btn.disabled = true;

  /* Model kosong: ambil dari penyedia, pakai yang pertama. Lebih baik daripada
     menolak dan menyuruh orang menebak nama model. */
  if (!model) {
    if (msg) msg.textContent = 'mengambil daftar model…';
    const fm = await fetchModels(baseUrl, key);
    if (fm.ok && fm.models.length) {
      model = pickModel(fm.models);
      fillModelList(fm.models);
      const inp = document.getElementById('setup-model');
      if (inp) inp.value = model;
    }
  }
  if (!model) {
    if (btn) btn.disabled = false;
    if (msg) msg.textContent = 'Nama model wajib diisi — daftar model tidak bisa diambil otomatis.';
    return;
  }

  if (msg) msg.textContent = 'menguji koneksi ke ' + model + '…';
  const r = await probeLlm(baseUrl, key, model);
  if (btn) btn.disabled = false;
  if (!r.ok) { if (msg) msg.textContent = r.message; return; }

  lsLlmSet({ enabled: true, provider, baseUrl, key, model });
  closeModal();
  render();
  log('info', 'LLM pribadi tersimpan di browser ini — model ' + model + ' (' + baseUrl + ')');
}

function openLlmSetup() {
  const p = AI_PRESETS.openai;
  const opts = Object.keys(AI_PRESETS)
    .filter((k) => k !== 'gemini')
    .map((k) => `<option value="${k}"${k === 'openai' ? ' selected' : ''}>${AI_PRESETS[k].label}</option>`).join('');
  openModal(`
    <div class="modal-head">
      <div><h3>Pakai LLM kamu sendiri</h3><p>Sekali isi, tersimpan di browser ini saja.</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      <div class="hint mb14">
        Aplikasi ini menjalankan 3 agen (Planner → Writer → Reviewer) di browser, jadi butuh
        satu endpoint <b>OpenAI-compatible</b>. Key tidak dikirim ke server mana pun — hanya
        dipakai browser ini untuk memanggil penyedia pilihanmu.
      </div>

      <div class="field">
        <div class="field-label"><span>Penyedia</span></div>
        <select class="select" id="setup-provider" style="max-width:none;width:100%">${opts}</select>
      </div>

      <div class="field mt14">
        <div class="field-label"><span>Base URL</span></div>
        <input class="input" id="setup-base" value="${esc(p.base)}" placeholder="https://api.openai.com/v1">
      </div>

      <div class="field mt14">
        <div class="field-label"><span>API key</span></div>
        <input class="input" type="password" id="setup-key" placeholder="sk-…" autocomplete="off">
      </div>

      <div class="field mt14">
        <div class="field-label"><span>Model</span></div>
        <input class="input" id="setup-model" value="${esc(p.models[0])}" list="setup-model-list" placeholder="gpt-4o-mini" autocomplete="off">
        <datalist id="setup-model-list"></datalist>
        <div class="row mt14">
          <button class="btn btn-sm" type="button" data-act="llm-fetch-models">Ambil daftar model</button>
          <span class="tiny muted">memakai Base URL dan key di atas</span>
        </div>
      </div>

      <div class="hint mt14">
        Endpoint di <code>localhost</code> tidak akan bekerja dari halaman ini: browser memblokir
        halaman publik yang memanggil jaringan lokal. Pakai alamat HTTPS milik penyedia.
      </div>

      <div class="tiny muted mt14" data-setup-msg></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-act="llm-setup-skip">Nanti saja</button>
      <button class="btn btn-primary" data-act="llm-setup-save">Tes &amp; simpan</button>
    </div>`);
}

function maybeLlmSetup() {
  /* Server sudah punya LLM sendiri: pengunjung tidak perlu mengisi apa pun.
     Ini yang membuat juri bisa langsung memakai aplikasi. */
  if (SERVER_LLM && SERVER_LLM.configured) return;
  if (lsLlmActive()) return;                 // browser ini sudah punya setelan
  const c = aiCfg();
  if (c && c.key) return;                    // database sudah menyimpan kunci
  try { if (sessionStorage.getItem(LS_SKIP)) return; } catch (e) { /* abaikan */ }
  openLlmSetup();
}

/* ---- editor prompt & bank kalimat plot ---- */
function overridesFor(cat) { return (S.copy && S.copy[cat]) || {}; }

function clearUsed(cat) {
  Array.from(_usedLines.keys()).forEach((k) => { if (k.indexOf(cat + '|') === 0) _usedLines.delete(k); });
}

/* Bank kalimat sekarang cuma contoh nada untuk prompt LLM. Mengubahnya tidak
   langsung menulis ulang konten — itu berarti memanggil LLM untuk semua item
   tanpa diminta. Jadi cukup ditandai regenerate; user memutuskan kapan jalan. */
function markRegenCategory(cat) {
  let n = 0;
  S.items.forEach((it) => {
    if (it.archived) return;
    if (cat && it.category !== cat) return;
    if (!hasContent(it, 'threads')) return;
    plat(it, 'threads').status = 'regenerate';
    n++;
  });
  return n;
}

function copyEditorCard() {
  const plot = S.ui.copyPlot || 'p1';
  const catKey = CATS[S.ui.copyCat] ? S.ui.copyCat : 'safety';
  const slots = PLOT_SLOTS[plot] || [];
  const ov = overridesFor(catKey);
  const editedCount = Object.keys(ov).filter((k) => Array.isArray(ov[k]) && ov[k].length).length;

  return `
  <div class="card mb14">
    <div class="card-head">
      <h3>Prompt &amp; bank kalimat plot</h3>
      <span class="badge b-brand">Threads</span>
    </div>
    <div class="card-body">
      <div class="hint mb14">
        Konten ditulis <b>LLM</b>; bank kalimat di bawah dikirim sebagai <b>contoh nada bicara</b>, bukan kerangka yang disalin.
        <b>Satu baris = satu varian</b> — jangan tekan Enter di tengah kalimat, karena app memilih varian berbeda untuk tiap produk supaya tidak monoton.
        Menyimpan perubahan hanya <b>menandai</b> konten terkait untuk regenerate; tulisan ulang baru jalan saat kamu tekan Regenerate.
      </div>

      <div class="segmented mb14" style="flex-wrap:wrap">
        ${PLOT_ORDER.map((p) => `<button data-act="copy-plot" data-plot="${p}" class="${p === plot ? 'active' : ''}">${p.toUpperCase()} · ${PLOTS[p].name}</button>`).join('')}
      </div>

      <div class="row mb14" style="align-items:flex-end">
        <div style="flex:1">
          <div class="field-label"><span>Kategori produk</span></div>
          <select class="select" data-copysel="cat" style="max-width:none;width:100%">
            ${Object.keys(CATS).map((k) => `<option value="${k}"${k === catKey ? ' selected' : ''}>${CATS[k].icon || ''} ${CATS[k].label}</option>`).join('')}
          </select>
        </div>
        <div class="tiny muted" style="flex:1;padding-bottom:8px">
          ${editedCount} dari ${slots.length} slot di kategori ini sudah diubah dari default.
        </div>
      </div>

      <div class="stack">
        ${slots.map((sl) => {
          const lines = slotLines(catKey, sl.key);
          const isOv = !!(ov[sl.key] && ov[sl.key].length);
          return `<div class="field">
            <div class="field-label">
              <span>${sl.label}${isOv ? ' <span class="badge b-warn">diedit</span>' : ''}</span>
              <span class="counter">${lines.length} varian</span>
            </div>
            <textarea class="textarea" rows="3" data-slot="${sl.key}" placeholder="Satu kalimat per baris…">${esc(lines.join('\n'))}</textarea>
            <div class="tiny muted mt8">${sl.note || ''} · <code>${sl.key}</code></div>
          </div>`;
        }).join('')}
      </div>

      <div class="row mt14">
        <button class="btn btn-primary" data-act="copy-save">Simpan &amp; regenerate</button>
        <button class="btn" data-act="copy-reset-plot">Reset plot ini</button>
        <button class="btn btn-danger" data-act="copy-reset-all">Reset semua plot</button>
      </div>
    </div>
  </div>`;
}

/* ---- pengaturan ---- */
function settingsSnapshot() {
  return {
    savedAt: Date.now(),
    settings: { ...S.settings },
    ai: JSON.parse(JSON.stringify(S.ai)),
    copy: S.copy || {}
  };
}

function seedText(obj) {
  return '/* Pengaturan Affiliate Studio — export ' + new Date(obj.savedAt).toLocaleString('id-ID') + '\n'
    + '   Timpa file pengaturan.js di folder aplikasi dengan isi file ini. */\n'
    + 'window.SAVED_SETTINGS = ' + JSON.stringify(obj, null, 2) + ';\n';
}

function cfgFileCard() {
  const seed = SEED;
  const keysSet = aiCfg().key ? 1 : 0;
  const src = SEED_NOTE || 'database (data/affiliate.db)';
  const when = S.seedStamp ? fmtDateTime(S.seedStamp) : '—';
  const storeWord = 'database (data/affiliate.db)';
  return `
  <div class="card mb14">
    <div class="card-head">
      <h3>Penyimpanan pengaturan</h3>
      <span class="badge ${keysSet ? 'b-ok' : ''}">${keysSet} API key tersimpan</span>
    </div>
    <div class="card-body">
      <div class="kv"><span>Pengaturan disimpan di</span><b>${esc(storeWord)}</b></div>
      <div class="kv"><span>Terakhir dimuat dari</span><b>${esc(src)}</b></div>
      <div class="kv"><span>Terakhir dari file</span><b>${esc(when)}</b></div>
      <div class="kv"><span>Bank kalimat diedit</span><b>${Object.keys(S.copy || {}).length} kategori</b></div>
      <div class="hint mt14">
        Pengaturan (mode posting, retry, jam, konfigurasi LLM, bank kalimat) tersimpan di database
        bersama data produk. Tombol di bawah membuat file <code>pengaturan.js</code> berisi JSON yang sama —
        berguna sebagai nilai awal kalau database dibuat ulang dari nol.
      </div>
      <div class="row mt14">
        <button class="btn btn-primary" data-act="cfg-export">Export pengaturan (JSON)</button>
        <button class="btn" data-act="cfg-import">Import dari file</button>
        <button class="btn btn-ghost" data-act="cfg-show">Lihat JSON</button>
      </div>
      <div class="tiny muted mt8">API key ikut terekspor. Jangan bagikan file ini ke orang lain.</div>
    </div>
  </div>`;
}

function viewPengaturan() {
  const s = S.settings;
  return `
  ${cfgFileCard()}
  ${llmLokalCard()}
  ${aiCard()}
  ${copyEditorCard()}
  <div class="grid-2">
    <div class="stack">
      <div class="card">
        <div class="card-head"><h3>Mode posting</h3></div>
        <div class="card-body">
          <div class="row">
            <label class="chk"><input type="radio" name="mode" value="simulasi" ${s.mode === 'simulasi' ? 'checked' : ''} data-set="mode"> Simulasi (auto-post, untuk uji alur)</label>
            <label class="chk"><input type="radio" name="mode" value="manual" ${s.mode === 'manual' ? 'checked' : ''} data-set="mode"> Manual (posting sendiri, tandai hasil)</label>
          </div>
          <div class="hint mt14">
            Auto-post ke Threads & TikTok butuh <b>API resmi + app review</b> dari masing-masing platform. Tanpa itu, mode manual adalah alur yang realistis: sistem menyiapkan caption, jadwal, dan reminder; kamu posting lalu tandai.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Retry & jadwal</h3></div>
        <div class="card-body">
          <div class="field">
            <div class="field-label"><span>Tingkat gagal simulasi</span><span class="counter">${s.failRate}%</span></div>
            <input type="range" min="0" max="80" step="5" value="${s.failRate}" data-set="failRate" style="width:100%;accent-color:var(--brand)">
          </div>
          <div class="row">
            <div style="flex:1">
              <div class="field-label"><span>Maks percobaan</span></div>
              <input class="input" type="number" min="1" max="10" value="${s.maxAttempts}" data-set="maxAttempts">
            </div>
            <div style="flex:1">
              <div class="field-label"><span>Jeda retry (menit)</span></div>
              <input class="input" type="number" min="1" max="120" value="${s.retryDelay}" data-set="retryDelay">
            </div>
          </div>
          <div class="field mt14">
            <div class="field-label"><span>Zona waktu audiens</span></div>
            <select class="input" data-set="tzAudience">
              ${TZ_LIST.map((x) => `<option value="${x.id}" ${(s.tzAudience || 'Asia/Jakarta') === x.id ? 'selected' : ''}>${x.full}</option>`).join('')}
            </select>
            <div class="tiny muted" style="margin-top:4px">
              Perangkat ini: ${esc(deviceTzLabel())}. ${deviceTzLabel() === tzLabel() ? 'Sama dengan audiens.' : `Beda — jam di bawah dibaca sebagai ${tzLabel()}, bukan ${deviceTzLabel()}.`}
            </div>
          </div>
          <div class="row mt14">
            <div style="flex:1">
              <div class="field-label"><span>Threads · puncak utama</span></div>
              <input class="input" type="number" min="0" max="23" value="${s.hourThreads}" data-set="hourThreads">
            </div>
            <div style="flex:1">
              <div class="field-label"><span>Threads · puncak kedua</span></div>
              <input class="input" type="number" min="0" max="23" value="${s.hourThreads2}" data-set="hourThreads2">
            </div>
          </div>
          <div class="row mt14">
            <div style="flex:1">
              <div class="field-label"><span>TikTok · puncak utama</span></div>
              <input class="input" type="number" min="0" max="23" value="${s.hourTiktok}" data-set="hourTiktok">
            </div>
            <div style="flex:1">
              <div class="field-label"><span>TikTok · puncak kedua</span></div>
              <input class="input" type="number" min="0" max="23" value="${s.hourTiktok2}" data-set="hourTiktok2">
            </div>
            <div style="flex:1">
              <div class="field-label"><span>Jarak antar posting</span></div>
              <input class="input" type="number" min="5" max="240" value="${s.gapMin}" data-set="gapMin">
            </div>
          </div>
          <div class="hint mt14">
            Jam di atas adalah <b>jam puncak penonton</b> di zona ${tzLabel()} — bukan jam tayang, dan bukan jam perangkat Bos.
            TikTok dijadwalkan <b>30 menit lebih awal</b> (${String(s.hourTiktok).padStart(2, '0')}.00 puncak → tayang
            ${String((s.hourTiktok + 23) % 24).padStart(2, '0')}.30); khusus Sabtu digeser 1 jam lebih awal.
            Threads tayang tepat di jam puncak. <b>Dua jendela per platform per hari</b> — jendela kedua dipakai kalau
            jendela utama di hari itu sudah terisi. Alasannya: engagement 60 menit pertama yang menentukan distribusi.
          </div>
        </div>
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <div class="card-head"><h3>Ringkasan data</h3></div>
        <div class="card-body">
          <div class="kv"><span>Produk</span><b>${activeItems().length}</b></div>
          <div class="kv"><span>Konten dibuat</span><b>${activeItems().length * 2}</b></div>
          <div class="kv"><span>Konten lolos</span><b>${counts().approved}</b></div>
          <div class="kv"><span>Sudah diposting</span><b>${counts().posted}</b></div>
          <div class="kv"><span>Log tersimpan</span><b>${S.logs.length}</b></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Data &amp; backup</h3><span class="badge ${storageHealthy() ? 'b-ok' : 'b-danger'}">${storageHealthy() ? 'tersimpan' : 'bermasalah'}</span></div>
        <div class="card-body stack">
          <div class="kv"><span>Penyimpanan</span><b style="font-weight:600">SQLite (server lokal)</b></div>
          <div class="kv"><span>Lokasi</span><b style="font-weight:600">data/affiliate.db</b></div>
          <div class="kv"><span>Revisi</span><b>${STORE.rev}</b></div>
          <div class="kv"><span>Ukuran tersimpan</span><b>${fmtBytes(STORE.bytes)}</b></div>
          <div class="kv"><span>Simpan terakhir</span><b>${STORE.savedAt ? fmtDateTime(STORE.savedAt) : '—'}</b></div>
          <div class="kv"><span>Cache browser</span><b>tidak dipakai</b></div>
          <button class="btn btn-block btn-primary" data-act="state-export">Backup semua data (JSON)</button>
          <button class="btn btn-block" data-act="state-import">Pulihkan dari backup</button>
          <button class="btn btn-block" data-act="verify-save">Cek penyimpanan sekarang</button>
          <button class="btn btn-block" data-act="export-json">Export konten (JSON)</button>
          <button class="btn btn-block" data-act="export-csv">Export jadwal &amp; status (CSV)</button>
          <button class="btn btn-block btn-danger" data-act="reset">Reset ke data awal</button>
          <div class="hint">
            Satu-satunya tempat data tinggal adalah <code>data/affiliate.db</code>, ditulis oleh
            <code>server.py</code>. Browser tidak menyimpan salinan apa pun — jadi membuka lewat
            browser, port, atau perangkat lain tidak bisa memunculkan data yang berbeda.
            Server juga menyimpan sampai 60 snapshot otomatis.
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------- render ---------------- */
/* layar pengunci: dipakai selama database belum/tidak terhubung */
function gateView() {
  /* dibuka langsung dari folder: bukan error, cuma belum di tempat yang benar */
  if (STORE.mode === 'file') {
    return `<div class="card">
      <div class="card-body">
        <h3 style="margin:0 0 6px">Buka aplikasi lewat server</h3>
        <div class="tiny muted" style="line-height:1.7">
          Halaman ini dibuka langsung dari folder (<code>file://</code>). Browser memblokir halaman
          seperti ini untuk menghubungi database lokal, jadi aplikasinya harus dibuka dari alamat server.
        </div>
        <div class="row mt14">
          <a class="btn btn-primary" href="${SERVER_ORIGIN}/" style="text-decoration:none">Buka ${SERVER_ORIGIN}/</a>
        </div>
        <div class="hint mt14">
          Kalau tombol itu tidak membuka apa pun, servernya belum jalan: klik dua kali
          <code>mulai.bat</code> di folder aplikasi. Jendela server terbuka, browsernya langsung
          diarahkan ke alamat yang benar — dan data tersimpan di <code>data/affiliate.db</code>.
        </div>
      </div>
    </div>`;
  }

  if (STORE.mode === 'connecting') {
    return `<div class="card"><div class="card-body">
      <h3 style="margin:0 0 4px">Menghubungkan ke database…</h3>
      <div class="tiny muted">Membaca <code>data/affiliate.db</code> lewat server lokal.</div>
    </div></div>`;
  }

  return `<div class="card" style="border-color:var(--danger)">
    <div class="card-body">
      <h3 style="margin:0 0 6px;color:var(--danger)">Database tidak terhubung</h3>
      <div class="tiny">${esc(STORE.err || 'server lokal tidak menjawab')}</div>
      <div class="hint mt14">
        Jalankan <code>mulai.bat</code> (atau <code>python server.py</code>), lalu klik tombol di bawah.
      </div>
      <div class="row mt14">
        <button class="btn btn-primary" data-act="open-server">Buka ${SERVER_ORIGIN}/</button>
        <button class="btn" data-act="retry-connect">Coba hubungkan lagi</button>
      </div>
      <div class="hint mt14">
        Alamat yang benar: <a href="${SERVER_ORIGIN}/" style="color:inherit"><b>${SERVER_ORIGIN}/</b></a>.
        Selama alamat itu tidak bisa dibuka, aplikasi tidak menerima input — supaya tidak ada
        pekerjaan yang menguap saat halaman di-refresh.
      </div>
    </div>
  </div>`;
}

function render() {
  const [title, sub] = PAGE_META[S.ui.view] || PAGE_META.dashboard;
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;

  renderNav();

  /* gerbang: tanpa database, tidak ada satu pun form yang boleh aktif */
  if (STORE.mode !== 'server') {
    $('#view').innerHTML = gateView();
    $('#topActions').innerHTML = '';
    return;
  }

  const views = {
    dashboard: viewDashboard,
    data: viewData,
    review: viewReview,
    jadwal: viewJadwal,
    pengaturan: viewPengaturan
  };
  $('#view').innerHTML = (views[S.ui.view] || viewDashboard)();

  /* tulis gagal di tengah kerja: katakan di setiap halaman, jangan diam */
  if (!storageHealthy()) {
    const konflik = !!STORE.conflict;
    $('#view').innerHTML = `
      <div class="card mb14" style="border-color:var(--danger)">
        <div class="card-body">
          <h3 style="margin:0 0 4px;color:var(--danger)">${konflik ? 'Database sudah diubah pihak lain' : 'Perubahan terakhir gagal disimpan'}</h3>
          <div class="tiny">${esc(STORE.err || 'server lokal tidak merespons')} ${konflik
            ? 'Perubahan di tab ini <b>ditahan</b> supaya tidak menimpa data yang lebih baru.'
            : 'Perubahan ini masih di memori dan akan hilang kalau halaman ditutup.'}</div>
          <div class="row mt14">
            ${konflik
              ? `<button class="btn btn-primary" data-act="reload-remote">Muat ulang dari database</button>
                 <button class="btn" data-act="state-export">Backup perubahan tab ini</button>`
              : `<button class="btn btn-primary" data-act="retry-connect">Coba simpan lagi</button>
                 <button class="btn" data-act="state-export">Backup ke file</button>`}
          </div>
        </div>
      </div>` + $('#view').innerHTML;
  }

  const empty = !S.items.filter((i) => !i.archived).length;
  const acts = {
    dashboard: empty
      ? `<button class="btn btn-sm" data-act="nav" data-view="data">Import data →</button>`
      : `<button class="btn btn-sm" data-act="nav" data-view="review">Review konten</button>
                <button class="btn btn-sm btn-primary" data-act="regen-all" ${aiReady() ? '' : 'disabled title="Isi konfigurasi LLM di Pengaturan"'}>Generate ulang semua</button>`,
    data: `<button class="btn btn-sm" data-act="nav" data-view="review">Ke review →</button>`,
    review: `<button class="btn btn-sm" data-act="nav" data-view="jadwal">Ke penjadwalan →</button>`,
    jadwal: `<button class="btn btn-sm" data-act="nav" data-view="review">← Review konten</button>`,
    pengaturan: ''
  };
  $('#topActions').innerHTML = acts[S.ui.view] || '';

  // autoresize textarea
  $$('#view textarea.textarea').forEach((t) => {
    t.style.height = 'auto';
    t.style.height = Math.max(38, t.scrollHeight + 2) + 'px';
  });
}

/* ---------------- ekstraksi detail lewat web ----------------
   Browser tidak bisa menjalankan proses, jadi server yang mengerjakannya:
   POST /api/extract memulai, GET /api/extract memantau. Hasilnya langsung
   dibaca dari data/detail_produk.json lalu ditempel ke database. */
let _exTimer = null;
let SHOPEE_CAP = null;          // hasil pemeriksaan kemampuan server terakhir
let _shopeeProceed = null;      // aksi yang dijalankan kalau pengguna memilih lanjut

function shopeeBlocked() {
  return !!(SHOPEE_CAP && SHOPEE_CAP.available === false);
}

async function probeShopee() {
  try {
    const r = await fetch(API + '/extract', { cache: 'no-store' });
    const j = await r.json();
    SHOPEE_CAP = j.capability || null;
  } catch (e) {
    SHOPEE_CAP = null;          // server diam: jangan mengklaim apa pun
  }
  return SHOPEE_CAP;
}

/* Keterangan keadaan, bukan peringatan galat. Detail belum bisa diambil dari
   server karena akses Shopee Open API belum ada — jadi yang ditampilkan
   adalah sebabnya, apa yang dipakai sementara, dan rencananya. */
function openShopeeNotice(opts) {
  const o = opts || {};
  const cap = SHOPEE_CAP || {};
  const alasan = cap.reason === 'dimatikan'
    ? 'Ekstraksi dimatikan lewat konfigurasi server.'
    : 'Server berjalan di IP datacenter, dan Shopee menolak permintaan halaman produk dari alamat seperti itu.';
  openModal(`
    <div class="modal-head">
      <div><h3>Detail produk belum bisa diambil dari server</h3><p>Akses Shopee Open API belum tersedia.</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      <div class="hint mb14">${esc(alasan)}</div>
      <div class="kv"><span>Akses Shopee Open API</span><b>belum ada</b></div>
      <div class="kv"><span>Scrap halaman dari server</span><b>diblokir Shopee</b></div>
      <div class="kv"><span>Sumber data sekarang</span><b>katalog + detail yang sudah diekstrak</b></div>
      <div class="hint mt14">
        <b>Rencana pengembangan:</b> begitu akun <b>Shopee Developer</b> mendapat akses
        <b>Shopee Open API</b>, detail produk — spesifikasi, varian, deskripsi, harga —
        diambil dari API resmi, bukan dari halaman web. Tombol ini akan berfungsi lagi
        tanpa mengubah data yang sudah ada.
      </div>
      <div class="hint mt14">
        Sementara ini konten dibuat dari <b>data yang sudah ada</b>: nama, harga, terjual,
        toko, komisi, dan detail produk yang pernah diekstrak. Tanpa detail, draf lebih
        umum karena spesifikasi dan catatan ukuran tidak ikut.
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">Mengerti</button>
      ${o.withImport === false ? '' : '<button class="btn" data-act="import-detail">Impor hasil manual (JSON)</button>'}
      ${o.proceedLabel ? `<button class="btn btn-primary" data-act="shopee-proceed">${esc(o.proceedLabel)}</button>` : ''}
    </div>`);
}

/* Jalankan fn hanya kalau pengguna setuju lanjut tanpa detail. */
function askProceed(label, fn) {
  _shopeeProceed = () => { closeModal(); fn(); };
  openShopeeNotice({ proceedLabel: label });
}

/* Sekali per sesi, saat tab Data Produk dibuka: pengunjung perlu tahu sebabnya
   sebelum menekan tombol yang tidak akan berhasil. Tidak diulang terus supaya
   tidak menghalangi pekerjaan. */
function maybeShopeeNotice() {
  if (!shopeeBlocked() || S.ui.view !== 'data') return;
  if (document.querySelector('.modal')) return;         // jangan menimpa modal lain
  try { if (sessionStorage.getItem('afiliasi.shopee.notice-seen')) return; } catch (e) { /* abaikan */ }
  try { sessionStorage.setItem('afiliasi.shopee.notice-seen', '1'); } catch (e) { /* abaikan */ }
  openShopeeNotice();
}

function openExtractModal() {
  openModal(`
    <div class="modal-head"><div><h3>Mengambil detail produk</h3><p>Chrome headless membuka halaman Shopee satu per satu.</p></div></div>
    <div class="modal-body">
      <div class="tiny muted" data-ex-text>Menghubungi server…</div>
      <div class="progress mt14"><i data-ex-bar style="width:0%"></i></div>
      <div class="tiny muted mt8" data-ex-count></div>
      <pre data-ex-log style="max-height:170px;overflow:auto;background:#fafafa;border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:10px;font-size:11px;line-height:1.6;white-space:pre-wrap"></pre>
      <div class="hint mt14">Jeda 9–15 detik antar produk supaya tidak kena proteksi Shopee. Jangan tutup jendela server selama proses berjalan.</div>
    </div>
    <div class="modal-foot"><button class="btn" data-close="1">Tutup</button></div>`);
}

async function startExtractUI() {
  let j;
  try {
    const r = await fetch(API + '/extract', { method: 'POST' });
    j = await r.json();
  } catch (e) {
    j = { status: 'error', error: String(e.message || e) };
  }
  if (j && j.capability) SHOPEE_CAP = j.capability;
  /* Server menjawab "unavailable" kalau detail memang tidak mungkin diambil
     dari sini — bukan kegagalan, jadi tidak perlu modal progres yang berputar. */
  if (j && j.status === 'unavailable') { openShopeeNotice(); return; }
  openExtractModal();
  pollExtract();
}

function exEl(sel) { return document.querySelector(sel); }

async function pollExtract() {
  clearTimeout(_exTimer);
  const bar = exEl('[data-ex-bar]');
  if (!bar) return;                      // modal sudah ditutup: hentikan pemantauan

  let j;
  try {
    const r = await fetch(API + '/extract', { cache: 'no-store' });
    j = await r.json();
  } catch (e) {
    exEl('[data-ex-text]').textContent = 'Server tidak menjawab — proses mungkin berhenti.';
    return;
  }

  const total = j.total || j.pending || 0;
  const done = Math.min(j.done || 0, total || 99);
  const pct = total ? Math.round((done / total) * 100) : (j.status === 'running' ? 5 : 100);
  bar.style.width = pct + '%';

  const txt = exEl('[data-ex-text]');
  const cnt = exEl('[data-ex-count]');
  const log = exEl('[data-ex-log]');

  if (j.status === 'running') {
    txt.textContent = j.current ? 'Mengambil: ' + j.current : 'Menyiapkan…';
    cnt.textContent = `${done}/${total || '?'} selesai · ${j.ok || 0} berhasil · ${j.failed || 0} gagal`;
  } else if (j.status === 'done') {
    txt.textContent = total ? `Selesai — ${j.ok || 0} berhasil, ${j.failed || 0} gagal.` : 'Tidak ada produk yang perlu diekstrak.';
    cnt.textContent = total ? 'Hasil ditempel ke database.' : '';
  } else if (j.status === 'error') {
    txt.textContent = 'Gagal: ' + (j.error || 'lihat log');
  } else {
    txt.textContent = 'Belum ada proses berjalan.';
  }
  if (log && j.log) {
    log.textContent = j.log.slice(-14).join('\n');
    log.scrollTop = log.scrollHeight;
  }

  if (j.status === 'running') {
    _exTimer = setTimeout(pollExtract, 1200);
    return;
  }

  /* selesai: tarik hasilnya dan tempel ke database */
  if (j.status === 'done' && total) {
    let masuk = 0;
    try {
      const res = await fetch('data/detail_produk.json?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const obj = await res.json();
        const r = mergeDetails(obj);
        masuk = r.ok || 0;
        if (masuk) logExtractResult(r);
      }
    } catch (e) { /* biarkan: hasil tetap ada di file, bisa diimpor manual */ }

    /* Media diunduh di proses yang sama, tapi bukan bagian dari detail.
       Segarkan daftar aset walau tidak ada detail baru. */
    const asetBaru = await refreshAssets();
    if (masuk) save();
    if (masuk || asetBaru) render();
    const jumlahAset = S.items.reduce((n, i) => n + assetsOf(i).length, 0);
    const cntEl = exEl('[data-ex-count]');
    if (asetBaru && jumlahAset && cntEl) {
      cntEl.textContent = `${masuk || 0} detail masuk · ${jumlahAset} file media di assets/`;
    }
  }
}

function logExtractResult(r) {
  const siap = S.items.filter((i) => i.detailStatus === 'ok' && !hasContent(i, 'threads') && !i.archived).length;
  log('ok', `Detail diambil lewat aplikasi: ${r.ok} produk${r.bad ? `, ${r.bad} gagal` : ''}${siap ? `, ${siap} siap digenerate` : ''}`);
  toast(`${r.ok} detail masuk${r.bad ? `, ${r.bad} gagal` : ''}${siap ? ` · ${siap} siap digenerate` : ''}`, 'ok');
}

/* ---------------- actions ---------------- */
/* ---- modal progres generate LLM ----
   steps = [{ pf, list }] — satu langkah untuk satu platform, dua langkah kalau
   Threads dan TikTok dibuat berurutan. Tidak ada fallback: yang gagal dibiarkan
   apa adanya dan dilaporkan di akhir. */
function openProgress(steps) {
  const arr = (Array.isArray(steps) ? steps : [steps]).filter((s) => s && s.list && s.list.length);
  if (!arr.length) return;
  const total = arr.reduce((a, s) => a + s.list.length, 0);
  const label = arr.map((s) => (s.pf === 'threads' ? 'Threads' : 'TikTok')).join(' + ');
  openModal(`
    <div class="modal-head"><div><h3>Generate ${label} dengan LLM</h3><p>Antrean berjalan — jangan tutup halaman ini.</p></div></div>
    <div class="modal-body">
      <div class="tiny muted" data-prog-text>Menyiapkan…</div>
      <div class="progress mt14"><i data-prog-bar style="width:0%"></i></div>
      <div class="hint mt14">Jeda 0,7 detik antar request supaya tidak kena rate limit. Kalau satu request gagal, konten lama dibiarkan dan error-nya dicatat — tidak diganti template.</div>
    </div>
    <div class="modal-foot"><button class="btn" data-close="1">Tutup</button></div>`);

  let done = 0, ok = 0, failed = 0, lastErr = '', moved = false;
  const setBar = (text, pct) => {
    const t = document.querySelector('[data-prog-text]');
    const b = document.querySelector('[data-prog-bar]');
    if (t) t.textContent = text;
    if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  };

  (async () => {
    for (const s of arr) {
      const r = await generateFor(s.pf, s.list, (n, tot, it) => {
        setBar(`${s.pf === 'threads' ? 'Threads' : 'TikTok'} ${n}/${tot} · ${String(it.name || '').slice(0, 40)}…`,
          ((done + n - 1) / total) * 100);
      });
      done += s.list.length;
      ok += r.ok; failed += r.failed;
      if (r.lastErr) lastErr = r.lastErr;
      if (r.moved) moved = true;
      setBar(`${done} / ${total} selesai`, (done / total) * 100);
    }
    save(); render(); closeModal();
    const msg = failed
      ? `${ok} berhasil, ${failed} gagal. Terakhir: ${lastErr}`
      : `${ok} konten dibuat dengan LLM`;
    const note = moved ? ' · filter dipindah ke Semua' : '';
    log(failed ? 'warn' : 'info', msg + note);
    toast(msg + note, failed ? 'err' : 'ok');
  })();
}

const ACTIONS = {
  /* ---- LLM lokal (localStorage) ---- */
  'ls-llm-toggle'(el) {
    const j = lsLlmGet() || {};
    j.enabled = !!el.checked;
    if (!j.baseUrl) j.baseUrl = 'http://127.0.0.1:20128/v1';
    if (!j.model) j.model = 'ag/gemini-3.8-flash-low';
    lsLlmSet(j);
    render();
    log('info', j.enabled
      ? 'LLM lokal aktif — permintaan langsung ke gateway, tidak lewat VPS'
      : 'LLM lokal dimatikan — kembali ke setelan server');
  },

  'ls-llm-test'() { testLlmLokal(); },

  'ls-fetch-models'(el) { fetchLsModels(el); },

  'ls-llm-clear'() {
    lsLlmSet(null);
    render();
    log('info', 'Setelan LLM lokal dihapus dari browser ini');
  },

  'llm-setup-save'(el) { saveLlmSetup(el); },

  'llm-fetch-models'(el) { fetchModelsToUi(el); },

  'llm-setup-skip'() {
    try { sessionStorage.setItem(LS_SKIP, '1'); } catch (e) { /* abaikan */ }
    closeModal();
    log('info', 'Penyiapan LLM dilewati — Generate dimatikan sampai diisi');
  },

  nav(el) { S.ui.view = el.dataset.view; save(); render(); window.scrollTo(0, 0); maybeShopeeNotice(); },

  tab(el) { S.ui.reviewTab = el.dataset.pf; S.ui.reviewFilter = 'semua'; save(); render(); },
  filter(el) { S.ui.reviewFilter = el.dataset.f; save(); render(); },
  'sched-filter'(el) { S.ui.schedFilter = el.dataset.f; save(); render(); },

  approve(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const v = validateContent(it, pf);
    if (!v.ok) {
      log('err', 'Tidak bisa lolos (' + pf + '): ' + v.reasons.join('; '));
      save(); render();
      toast('Belum bisa lolos — ' + v.reasons.slice(0, 2).join(' · '), 'err');
      return;
    }
    /* Reviewer yang menolak bukan saran. Kalau pipeline berhenti karena
       pelanggaran, manusia tidak bisa menekan Lolos begitu saja — harus
       menyatakan sadar lewat jalur override yang tercatat. */
    const rv = plat(it, pf).review;
    if (rv && rv.state === 'escalated' && !rv.override) {
      log('err', `Lolos ditolak (${pf}): ${rv.blocked.length} pelanggaran belum diselesaikan`);
      save(); render();
      toast('Reviewer masih menolak draf ini — lihat Jejak agent', 'err');
      return;
    }
    plat(it, pf).status = 'lolos';
    plat(it, pf).approvedAt = Date.now();
    if (rv) rv.humanApproved = { at: Date.now(), afterIterations: rv.iterations };
    autoSchedule(it, pf);
    log('ok', `Lolos review: ${it.name.slice(0, 34)}… (${pf})`);
    save(); render(); toast('Konten ditandai lolos', 'ok');
  },

  /* satu-satunya jalan menyetujui draf yang ditolak Reviewer: manusia
     menyatakan alasannya, dan alasannya ikut tersimpan di jejak agent. */
  override(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const p = plat(it, pf);
    const rv = p.review;
    if (!rv) return;
    const list = (rv.blocked || []).map((v) => `${v.ruleId} ${v.evidence}`).join(', ');
    const note = prompt(
      `Reviewer menolak draf ini karena:\n  ${list}\n\n` +
      'Kalau tetap disetujui, tulis alasan kenapa pelanggaran itu bisa diterima.\n' +
      'Alasan ini disimpan di jejak agent dan tidak bisa dihapus.',
      ''
    );
    if (note === null) return;
    if (!note.trim()) { toast('Alasan wajib diisi — persetujuan tanpa alasan tidak dicatat', 'err'); return; }
    rv.override = { at: Date.now(), note: note.trim().slice(0, 240), ruleIds: (rv.blocked || []).map((v) => v.ruleId) };
    p.status = 'lolos';
    p.approvedAt = Date.now();
    rv.humanApproved = { at: Date.now(), afterIterations: rv.iterations, overridden: true };
    if (!p.trace) p.trace = [];
    p.trace.push({ role: 'human', at: Date.now(), text: `Override: ${rv.override.note} (aturan: ${rv.override.ruleIds.join(', ')})` });
    autoSchedule(it, pf);
    log('warn', `Override review: ${it.name.slice(0, 30)}… (${pf}) — ${rv.override.note}`);
    save(); render();
    toast('Disetujui dengan catatan override', 'ok');
  },

  'approve-all'() {
    const pf = S.ui.reviewTab;
    let n = 0, blocked = 0;
    activeItems().forEach((i) => {
      const p = plat(i, pf);
      if (p.status === 'lolos' || p.status === 'batal') return;
      if (!validateContent(i, pf).ok) { blocked++; return; }
      p.status = 'lolos'; autoSchedule(i, pf); n++;
    });
    log('ok', `${n} konten ${pf} diloloskan${blocked ? `, ${blocked} ditahan karena belum valid` : ''}`);
    save(); render();
    toast(blocked ? `${n} lolos · ${blocked} ditahan (belum valid)` : `${n} konten lolos`, n ? 'ok' : 'err');
  },

  flag(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    plat(it, pf).status = 'regenerate';
    save(); render(); toast('Ditandai untuk regenerate');
  },

  'regen-now'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const jalan = () => {
      el.disabled = true;
      el.textContent = '…';
      generateFor(pf, [it]).then((r) => {
        save(); render();
        toast(r.ok ? 'Konten baru dibuat dengan LLM' + (r.moved ? ' · filter ke Semua' : '') : 'Gagal: ' + r.lastErr, r.ok ? 'ok' : 'err');
      });
    };
    /* Tanpa detail tetap boleh. Bedanya dijelaskan lebih dulu, bukan diblokir
       dengan confirm() yang isinya sama saja. */
    if (!draftReady(it)) { askProceed('Tetap generate', jalan); return; }
    jalan();
  },

  /* generate semua yang belum punya draf — detail bukan syarat */
  'gen-ready'(el) {
    const pf = el.dataset.pf;
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const list = activeItems().filter((i) => !hasContent(i, pf));
    if (!list.length) return toast('Tidak ada produk yang siap digenerate', '');
    openProgress([{ pf, list }]);
  },

  'regen-flagged'(el) {
    const pf = el.dataset.pf;
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const list = activeItems().filter((i) => plat(i, pf).status === 'regenerate' && hasContent(i, pf));
    if (!list.length) return toast('Tidak ada yang ditandai', '');
    openProgress([{ pf, list }]);
  },

  cancel(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const label = pf === 'threads' ? 'Threads' : 'TikTok';
    if (!confirm(`Batalkan draf ${label}?\n\nIsi draf TIDAK dihapus — hanya ditandai batal, dikeluarkan dari antrean, dan tidak bisa diedit sampai dipulihkan.\n\nKalau maksudmu mengosongkan isinya, tutup dialog ini lalu pakai tombol "Hapus draf".`)) return;
    plat(it, pf).status = 'batal';
    plat(it, pf).sched.at = null;
    plat(it, pf).sched.status = 'belum post';
    save(); render(); toast('Draf dibatalkan — isinya masih ada', '');
  },

  /* Hapus isi draf, bukan produknya. Produk tetap ada dan bisa digenerate
     ulang kapan saja. Salinan terakhir disimpan di riwayat revisi supaya
     suntingan manual tidak hilang tanpa jejak. */
  'del-draft'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const p = plat(it, pf);
    const label = pf === 'threads' ? 'Threads' : 'TikTok';
    if (!hasContent(it, pf)) { toast('Draf ' + label + ' ini sudah kosong', ''); return; }
    if (p.sched && p.sched.status === 'berhasil posting') {
      toast('Sudah tayang — draf tidak dihapus, cukup dibatalkan', 'err');
      return;
    }
    if (!confirm(`Hapus draf ${label} untuk "${it.name.slice(0, 42)}"?\n\nIsi draf dikosongkan dan jadwalnya dilepas. Produk tetap ada. Satu salinan disimpan di riwayat revisi, jadi masih bisa dipulihkan setelah draf baru dibuat.`)) return;

    const snap = JSON.parse(JSON.stringify(p));
    delete snap.history;
    snap.at = Date.now();
    p.history = (p.history || []).concat([snap]).slice(-MAX_HISTORY);
    p.rev = (p.rev || 1) + 1;

    Object.assign(p, emptyContent(pf));
    p.status = 'belum review';
    p.source = '';
    p.model = '';
    p.error = '';
    p.updatedAt = Date.now();
    p.sched = newSched();

    /* tutup barisnya: kalau dibiarkan terbuka, yang terlihat cuma kotak kosong
       besar dan baris lain terdorong jauh ke bawah — seperti form yang mati. */
    _revOpen.delete(it.key);

    log('info', `Draf ${label} dihapus: ${it.name.slice(0, 34)}…`);
    save(); render();
    toast(`Draf ${label} dihapus`, 'ok');
  },

  restore(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    plat(it, pf).status = 'belum review';
    save(); render(); toast('Konten dipulihkan');
  },

  /* pulihkan revisi lama. Revisi yang sudah tayang TIDAK dipulihkan diam-diam:
     memulihkannya berarti menyiapkan posting ulang, jadi butuh konfirmasi. */
  'restore-rev'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf, rev = +el.dataset.rev;
    if (!it) return;
    const p = plat(it, pf);
    const snap = (p.history || []).find((x) => x.rev === rev);
    if (!snap) return;
    const posted = !!(snap.sched && snap.sched.postedAt);
    if (posted && !confirm('Revisi ini sudah pernah tayang.\n\nMemulihkan berarti menyiapkan POSTING ULANG versi lama, bukan mengembalikan yang sudah tayang di platform. Lanjut?')) return;

    const cur = JSON.parse(JSON.stringify(p));
    delete cur.history;
    cur.at = Date.now();
    // revisi yang dipulihkan TETAP disimpan di riwayat — kalau dia sudah tayang,
    // catatan itu tidak boleh hilang hanya karena isinya dipakai lagi
    const kept = (p.history || []).concat([cur]);
    const nextRev = Math.max(p.rev || 1, ...kept.map((x) => x.rev || 0)) + 1;

    CONTENT_FIELDS[pf].forEach((f) => { p[f] = snap[f]; });
    p.plot = snap.plot || p.plot;
    p.source = snap.source || 'template';
    p.model = snap.model || '';
    p.status = 'belum review';
    p.sched = newSched();
    p.rev = nextRev;
    p.updatedAt = Date.now();
    p.history = kept.sort((a, b) => a.rev - b.rev).slice(-MAX_HISTORY);

    log('info', `Revisi ${rev} dipulihkan sebagai rev ${nextRev} (${pf})${posted ? ' — perlu posting ulang' : ''}`);
    save(); render();
    toast(posted ? 'Versi lama dimuat — siap diposting ulang' : 'Revisi dipulihkan', 'ok');
  },

  /* hapus satu entri riwayat revisi. Revisi yang pernah tayang adalah satusatunya
     catatan apa yang sudah dipublikasikan, jadi minta konfirmasi tegas. */
  'del-rev'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf, rev = +el.dataset.rev;
    if (!it) return;
    const p = plat(it, pf);
    const snap = (p.history || []).find((x) => x.rev === rev);
    if (!snap) return;
    const posted = !!(snap.sched && snap.sched.postedAt);
    const msg = posted
      ? `Revisi ${rev} ini sudah pernah tayang.\n\nMenghapusnya berarti catatan apa yang dipublikasikan ikut hilang — tidak bisa dikembalikan. Lanjut?`
      : `Hapus revisi ${rev} dari riwayat?\n\nRevisi yang sedang aktif tidak terpengaruh.`;
    if (!confirm(msg)) return;

    p.history = (p.history || []).filter((x) => x.rev !== rev);
    log('info', `Revisi ${rev} dihapus dari riwayat (${pf})`);
    save(); render();
    toast('Revisi ' + rev + ' dihapus', 'ok');
  },

  preview(el) { openPreview(findItem(el.dataset.key), el.dataset.pf); },

  detail(el) { openDetail(findItem(el.dataset.key)); },

  /* Satu tempat untuk semua bahan produk: teks, gambar, video.
     Tombol di kolom Aset dan kolom Detail membuka modal yang sama. */
  'aset-lihat'(el) { openDetail(findItem(el.dataset.key)); },

  'detail-clear'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    if (!confirm(`Hapus detail produk "${it.name.slice(0, 42)}"?\n\nProduknya tetap ada. Yang hilang hanya spesifikasi, stok varian, dan catatan logistik hasil ekstraksi — statusnya kembali "belum punya detail" dan bisa diekstrak ulang kapan saja.`)) return;
    it.detail = null;
    it.detailStatus = 'pending';
    log('info', `Detail dihapus: ${it.name.slice(0, 34)}…`);
    closeModal();
    save(); render();
    toast('Detail dihapus — produk kembali ke daftar yang perlu diekstrak');
  },

  'copy-post'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    const p = (plat(it, 'threads').posts || [])[+el.dataset.idx];
    if (p) copyText(p);
  },

  copy(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    copyText(pf === 'threads' ? threadText(it) : plat(it, 'tiktok').caption);
  },

  /* prompt untuk generator video: ditampilkan dulu di textarea supaya bisa
     diedit, baru disalin. Tidak langsung ke clipboard karena biasanya user
     perlu membuang/menambah satu dua adegan. */
  'video-prompt'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    if (!hasContent(it, 'tiktok')) { toast('Draf TikTok belum ada — generate dulu', 'err'); return; }
    _vpSeq++;                                        // batalkan terjemahan yang masih jalan
    const idText = videoPrompt(it);
    openModal(`
      <div class="modal-head">
        <div><h3>Prompt video</h3><p>${esc(String(it.name).slice(0, 70))}</p></div>
        <button class="x" data-close="1">×</button>
      </div>
      <div class="modal-body">
        <div class="vp-opts">
          <div class="vp-grp">
            <span class="vp-lbl">Durasi</span>
            <div class="segmented">
              ${VP_DUR.map(([v, lab]) => `<button class="${_vpOpts.dur === v ? 'active' : ''}" data-act="vp-opt" data-k="dur" data-v="${v}" data-key="${it.key}">${lab}</button>`).join('')}
            </div>
          </div>
          <div class="vp-grp">
            <span class="vp-lbl">Rasio</span>
            <div class="segmented">
              ${VP_RATIO.map((v) => `<button class="${_vpOpts.ratio === v ? 'active' : ''}" data-act="vp-opt" data-k="ratio" data-v="${v}" data-key="${it.key}">${v}</button>`).join('')}
            </div>
          </div>
          ${(() => {
            const n = sceneRows(plat(it, 'tiktok').scenes).length;
            if (n < 3) return '';
            const opts = [['auto', 'Auto']].concat(
              [3, 4, 5].filter((v) => v <= n).map((v) => [String(v), String(v)])
            );
            return `<div class="vp-grp">
            <span class="vp-lbl">Adegan</span>
            <div class="segmented">
              ${opts.map(([v, lab]) => `<button class="${_vpOpts.scenes === v ? 'active' : ''}" data-act="vp-opt" data-k="scenes" data-v="${v}" data-key="${it.key}">${lab}</button>`).join('')}
            </div>
            <span class="vp-count" data-vpcount="1">${vpCountLabel(sceneRows(plat(it, 'tiktok').scenes), _vpOpts, vpSpan(_vpOpts).sec)}</span>
          </div>`;
          })()}
        </div>
        <div class="hint mb14" data-vpnote="1">${_vpLang === 'en' ? 'Menyiapkan versi Inggris…' : VP_NOTE_ID}</div>
        <textarea class="textarea" rows="18" data-vprompt="1" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55">${esc(_vpLang === 'en' ? '' : idText)}</textarea>
      </div>
      <div class="modal-foot">
        <div class="segmented" style="align-self:center">
          <button class="${_vpLang === 'id' ? 'active' : ''}" data-act="vp-lang" data-lang="id" data-key="${it.key}">ID</button>
          <button class="${_vpLang === 'en' ? 'active' : ''}" data-act="vp-lang" data-lang="en" data-key="${it.key}">EN</button>
        </div>
        <div class="spacer"></div>
        <button class="btn" data-close="1">Tutup</button>
        <button class="btn btn-primary" data-act="copy-video-prompt">Salin prompt</button>
      </div>`);
    if (_vpLang === 'en') vpShowEN(it);
  },

  /* pindah bahasa di modal prompt video. ID = apa adanya dari draf.
     EN = diterjemahkan LLM; kalau LLM tidak siap, pakai kerangka Inggris. */
  'vp-lang'(el) {
    const lang = el.dataset.lang === 'en' ? 'en' : 'id';
    const it = findItem(el.dataset.key);
    if (!it) return;
    _vpLang = lang;
    document.querySelectorAll('[data-act="vp-lang"]').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === lang);
    });
    const ta = document.querySelector('[data-vprompt]');
    const note = document.querySelector('[data-vpnote]');
    if (!ta) return;
    if (lang === 'id') {
      _vpSeq++;
      ta.value = videoPrompt(it);
      delete ta.dataset.busy;
      if (note) note.textContent = VP_NOTE_ID;
    } else {
      vpShowEN(it);
    }
  },

  /* ganti durasi/rasio/jumlah adegan. Prompt disusun ulang; versi EN
     diterjemahkan lagi (atau diambil dari cache kalau kombinasinya sama). */
  'vp-opt'(el) {
    const k = el.dataset.k, v = el.dataset.v;
    if (!k || !v || _vpOpts[k] === v) return;
    _vpOpts[k] = v;
    document.querySelectorAll(`[data-act="vp-opt"][data-k="${k}"]`).forEach((b) => {
      b.classList.toggle('active', b.dataset.v === v);
    });
    const it = findItem(el.dataset.key);
    if (!it) return;
    const cnt = document.querySelector('[data-vpcount]');
    if (cnt) cnt.textContent = vpCountLabel(sceneRows(plat(it, 'tiktok').scenes), _vpOpts, vpSpan(_vpOpts).sec);
    if (_vpLang === 'en') { vpShowEN(it); return; }
    const ta = document.querySelector('[data-vprompt]');
    if (ta) ta.value = videoPrompt(it);
  },

  'copy-video-prompt'() {
    const ta = document.querySelector('[data-vprompt]');
    if (!ta) return;
    if (ta.dataset.busy === '1') { toast('Terjemahan masih diproses, tunggu sebentar', ''); return; }
    if (!ta.value.trim()) { toast('Prompt masih kosong', 'err'); return; }
    copyText(ta.value);
  },

  /* ---- video hasil generate ---- */
  'video-media'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    openMediaModal(it);
  },

  'vpick'() {
    const inp = document.querySelector('[data-vfile]');
    if (inp) inp.click();
  },

  /* tandai video mana yang dipakai saat posting. Tidak menyalin file — hanya
     menunjuk satu nama, jadi ganti versi tidak memakan ruang tambahan. */
  'vuse'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    const m = mediaOf(plat(it, 'tiktok'));
    if (!m.videos.some((v) => v.file === el.dataset.file)) return;
    m.pick = el.dataset.file;
    save(); render(); refreshMediaList(it);
    toast('Video ini yang dipakai saat posting', 'ok');
  },

  'vdel'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    if (!confirm('Hapus file video ini dari disk? Tindakan ini tidak bisa dibatalkan.')) return;
    deleteVideoFile(it, el.dataset.file);
  },

  'rotate-plots'() {
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const list = activeItems().filter((it) => hasContent(it, 'threads'));   // yang belum dibuat tidak ikut dirotasi
    if (!list.length) return toast('Belum ada utas untuk dirotasi', '');
    list.forEach((it) => {
      const idx = PLOT_ORDER.indexOf(it.plot || 'p1');
      it.plot = PLOT_ORDER[(idx + 1) % PLOT_ORDER.length];
      plat(it, 'threads').plot = it.plot;
    });
    log('info', `${list.length} utas dirotasi ke plot berikutnya`);
    save(); render();
    openProgress([{ pf: 'threads', list }]);
  },

  'regen-all'() {
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const semua = activeItems();
    if (!semua.length) return toast('Belum ada produk', 'err');
    const tanpa = semua.filter((i) => !draftReady(i)).length;
    if (tanpa && !confirm(`${semua.length} produk akan digenerate ulang.\n${tanpa} di antaranya belum punya detail, jadi drafnya dibuat dari data katalog saja.\n\nLanjut?`)) return;
    openProgress([{ pf: 'threads', list: semua }, { pf: 'tiktok', list: semua }]);
  },

  'toggle-run'() {
    S.ui.running = !S.ui.running;
    log('info', S.ui.running ? 'Penjadwal dijalankan' : 'Penjadwal dihentikan');
    save(); render();
    toast(S.ui.running ? 'Penjadwal berjalan' : 'Penjadwal berhenti', S.ui.running ? 'ok' : '');
  },

  autoschedule() {
    let n = 0;
    activeItems().forEach((i) => {
      ['threads', 'tiktok'].forEach((pf) => {
        if (autoSchedule(i, pf)) n++;
      });
    });
    log('info', `${n} slot jadwal dibuat otomatis`);
    save(); render(); toast(`${n} slot dijadwalkan`, 'ok');
  },

  /* Atur ulang SEMUA jadwal konten yang siap tayang ke jam prime.
     Beda dengan `autoschedule` yang hanya mengisi slot kosong: di sini jadwal
     lama ditimpa, karena yang lama dibuat dengan aturan "semua jam sama"
     (jam di Pengaturan + jarak 45 menit), bukan jam puncak.
     Yang sudah tayang tidak disentuh. */
  reschedule() {
    const rows = [];
    ['threads', 'tiktok'].forEach((pf) => {
      activeItems().forEach((i) => {
        const p = plat(i, pf);
        if (p.status !== 'lolos') return;
        if (p.sched.status === 'berhasil posting') return;
        rows.push({ i, pf, p });
      });
    });
    if (!rows.length) { toast('Belum ada konten lolos yang perlu dijadwalkan', ''); return; }
    if (!confirm(`Atur ulang ${rows.length} jadwal ke jam prime?\n\nJadwal lama akan ditimpa. Yang sudah tayang tidak disentuh.`)) return;

    /* kosongkan dulu: kalau tidak, tiap produk menabrak slotnya sendiri */
    rows.forEach(({ p }) => { p.sched.at = null; p.sched.gaveUp = false; });
    rows.forEach(({ i, pf }) => { plat(i, pf).sched.at = suggestSlot(pf, i); });

    const nt = rows.filter((r) => r.pf === 'threads').length;
    const nk = rows.length - nt;
    log('info', `Jadwal diatur ulang ke jam prime: ${nt} Threads, ${nk} TikTok`);
    save(); render();
    toast(`${rows.length} jadwal diatur ke jam prime`, 'ok');
  },

  'run-now'() {
    const now = Date.now();
    let n = 0, opened = false;
    activeItems().forEach((i) => {
      ['threads', 'tiktok'].forEach((pf) => {
        const s = plat(i, pf).sched;
        if (s.status === 'belum post' && s.at && s.at <= now && plat(i, pf).status === 'lolos' && !s.gaveUp) {
          if (S.settings.mode === 'manual') {
            if (!opened) { opened = true; openPostModal(i, pf); }
          } else { attemptPost(i, pf); n++; }
        }
      });
    });
    if (n > 0) { save(); render(); toast(`${n} posting diproses`); }
    else if (!opened) toast('Tidak ada yang jatuh tempo', '');
  },

  'mark-ok'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const s = plat(it, pf).sched;
    s.status = 'berhasil posting';
    s.postedAt = Date.now();
    s.attempts += 1;
    s.lastError = null;
    s.gaveUp = false;
    log('ok', `Posting manual ${pf} · ${it.name.slice(0, 34)}… ditandai berhasil`);
    save(); closeModal(); render(); toast('Ditandai berhasil posting', 'ok');
  },

  'mark-fail'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    const s = plat(it, pf).sched;
    s.attempts += 1;
    s.lastError = 'Gagal posting manual';
    if (s.attempts >= S.settings.maxAttempts) {
      s.gaveUp = true;
      log('err', `Posting manual ${pf} · ${it.name.slice(0, 34)}… gagal ${s.attempts}x — perlu retry manual`);
    } else {
      s.at = Date.now() + S.settings.retryDelay * 60000 * s.attempts;
      log('err', `Posting manual ${pf} · ${it.name.slice(0, 34)}… gagal, retry ${fmtSched(s.at)} ${tzLabel()}`);
    }
    save(); closeModal(); render(); toast('Dicatat gagal, retry dijadwalkan', 'err');
  },

  'post-now'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    if (S.settings.mode === 'manual') openPostModal(it, pf);
    else {
      attemptPost(it, pf);
      save(); render();
      toast(plat(it, pf).sched.status === 'berhasil posting' ? 'Berhasil diposting' : 'Gagal, retry dijadwalkan', plat(it, pf).sched.status === 'berhasil posting' ? 'ok' : 'err');
    }
  },

  'reset-post'(el) {
    const it = findItem(el.dataset.key), pf = el.dataset.pf;
    if (!it) return;
    plat(it, pf).sched = { at: suggestSlot(pf, it), status: 'belum post', attempts: 0, lastError: null, postedAt: null, gaveUp: false };
    save(); render(); toast('Status posting direset');
  },

  'import-csv'() {
    const txt = ($('#csvInput') || {}).value || '';
    if (!txt.trim()) return toast('Tempel data CSV dulu', 'err');
    const rows = parseCSV(txt.trim());
    const body = rows.length && /id produk/i.test(rows[0][0]) ? rows.slice(1) : rows;
    if (!body.length) return toast('Tidak ada baris di CSV', 'err');
    _pendingImport = planImport(body);
    if (!_pendingImport.added.length && !_pendingImport.updated.length) {
      _pendingImport = null;
      return toast('Tidak ada baris valid (butuh kolom ID Produk dan Nama Produk)', 'err');
    }
    openImportModal(_pendingImport);
  },

  'import-cancel'() {
    _pendingImport = null;
    closeModal();
  },

  'import-commit'() {
    if (!_pendingImport) return closeModal();
    const plan = _pendingImport;
    const r = applyImport(plan);
    _pendingImport = null;
    log('ok', `Import ${plan.batch}: +${r.added} baru · ${r.touched} diperbarui`);
    save(); closeModal(); render();
    toast(`${r.added} baru · ${r.touched} diperbarui`, 'ok');
  },

  'import-sample'() {
    const rows = parseCSV(SEED_CSV).slice(1);
    _pendingImport = planImport(rows);
    openImportModal(_pendingImport);
  },

  'riwayat-lihat'(el) {
    const r = (S.riwayat || [])[Number(el.dataset.rw)];
    if (!r) return;
    const pf = el.dataset.pf;
    const p = (r.platforms || {})[pf];
    if (!p) return;
    const isi = pf === 'threads'
      ? (p.posts || []).map((t, i) => `<div class="hint mt8" style="white-space:pre-wrap">${i + 1}. ${esc(t)}</div>`).join('')
      : `<div class="hint" style="white-space:pre-wrap">HOOK\n${esc(p.hook || '-')}\n\nSCENES\n${sceneRows(p.scenes).map((r) => `${r.n}. ${r.visual}${r.overlay ? ' [' + r.overlay + ']' : ''}${r.vo ? ' (VO: ' + r.vo + ')' : ''}`).join('\n')}\n\nCAPTION\n${esc(p.caption || '-')}\n\nHASHTAGS\n${esc((p.hashtags || []).join(' '))}</div>`;
    openModal(`
      <div class="modal-head"><div><h3>${esc(r.name || '-')}</h3>
        <p>${esc(pf)} · tayang ${p.sched && p.sched.postedAt ? fmtSched(p.sched.postedAt) + ' ' + tzLabel() : '—'} · rev ${p.rev || 1}</p></div>
        <button class="x" data-close="1">×</button></div>
      <div class="modal-body">${isi || '<div class="hint">Isi postingan tidak tersimpan.</div>'}</div>`);
  },

  'riwayat-bersihkan'() {
    if (!(S.riwayat || []).length) return;
    if (!confirm(`Hapus ${S.riwayat.length} catatan riwayat tayang?\n\nJejak postingan yang sudah berhasil tayang akan hilang dan tidak bisa dikembalikan.`)) return;
    S.riwayat = [];
    log('info', 'Riwayat tayang dikosongkan');
    save(); render(); toast('Riwayat tayang dikosongkan');
  },

  'export-pending'() {
    const list = activeItems().filter((i) => i.detailStatus !== 'ok')
      .map((i) => ({ id: i.productId, url: i.productUrl || ('https://shopee.co.id/product/' + i.productId) }));
    if (!list.length) return toast('Semua produk sudah punya detail', '');
    download('pending.json', JSON.stringify(list, null, 2), 'application/json');
    openModal(`
      <div class="modal-head"><div><h3>Ekstrak detail ${list.length} produk</h3><p>Detail dipakai untuk spesifikasi, catatan ukuran, dan klaim seller di konten.</p></div><button class="x" data-close="1">×</button></div>
      <div class="modal-body">
        <div class="hint">Daftar <code>pending.json</code> sudah diunduh. Jalankan tiga langkah ini di terminal — <b>di mesin lokal</b>, bukan di server: ekstraksi butuh Chrome desktop dan IP non-datacenter.</div>
        <ol class="tiny mt14" style="line-height:2;padding-left:18px">
          <li>Pindahkan <code>pending.json</code> ke folder <code>data/</code> (kalau tidak dipindah, skrip tetap mencarinya di folder Downloads).</li>
          <li>Jalankan <code>python scripts/extract_batch.py</code></li>
          <li>Kembali ke sini, klik <b>Import hasil ekstraksi (JSON)</b>, pilih <code>data/detail_produk.json</code>.</li>
        </ol>
        <div class="hint mt14">Produk yang sudah punya detail dilewati, jadi aman dijalankan berkali-kali — hanya yang pending yang diambil.</div>
        <div class="hint mt14">Skrip itu juga menulis ulang <code>detail.js</code>. Jadi detail tersimpan permanen di folder aplikasi, tidak hilang walau database dibuat ulang.</div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" data-close="1">Mengerti</button></div>`);
  },

  'extract-now'() {
    const aktif = activeItems();
    const pending = aktif.filter((i) => i.detailStatus !== 'ok' || !assetsOf(i).length);
    if (!pending.length) return toast('Semua produk sudah punya detail dan media', '');
    startExtractUI();
  },

  /* tombol "lanjut tanpa detail" di dalam keterangan Shopee */
  'shopee-proceed'() {
    const f = _shopeeProceed;
    _shopeeProceed = null;
    if (f) f(); else closeModal();
  },

  'shopee-notice'() { openShopeeNotice(); },

  'import-detail'() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        let obj;
        try { obj = JSON.parse(String(fr.result || '{}')); } catch (e) { return toast('File bukan JSON yang valid', 'err'); }
        const r = mergeDetails(obj);
        if (!r.ok && !r.bad) return toast('Tidak ada ID di file itu yang cocok dengan produk kamu', 'err');
        const siap = S.items.filter((i) => i.detailStatus === 'ok' && !hasContent(i, 'threads') && !i.archived).length;
        log('ok', `Detail diimport: ${r.ok} ok${r.bad ? `, ${r.bad} gagal` : ''}${siap ? `, ${siap} produk siap digenerate` : ''}`);
        save(); render();
        toast(`${r.ok} detail masuk${r.bad ? `, ${r.bad} gagal` : ''}${siap ? ` · ${siap} siap digenerate` : ''}`, r.ok ? 'ok' : 'err');
      };
      fr.readAsText(f);
    };
    inp.click();
  },

  'del-item'(el) {
    const it = findItem(el.dataset.key);
    if (!it) return;
    const tayang = PLATFORM_KEYS.filter((pf) => plat(it, pf).sched.status === 'berhasil posting').length;
    const pesan = tayang
      ? `Hapus permanen "${it.name.slice(0, 42)}"?\n\nKatalog, draf, dan jadwal ikut terhapus.\n${tayang} postingan yang sudah berhasil tayang tetap disimpan di Riwayat tayang.`
      : `Hapus permanen "${it.name.slice(0, 42)}"?\n\nKatalog, draf, dan jadwal ikut terhapus. Tidak bisa dibatalkan.`;
    if (!confirm(pesan)) return;
    const n = hapusItemPermanen(it);
    syncMeta();
    log('info', `Produk dihapus permanen: ${it.name.slice(0, 34)}…${n ? ` · ${n} postingan tayang disimpan` : ''}`);
    save(); render();
    toast(n ? `Dihapus · ${n} postingan tayang disimpan` : 'Produk dihapus permanen');
  },

  'clear-all'() {
    if (!S.items.length) return toast('Belum ada produk', '');
    if (!confirm(`Hapus permanen SEMUA produk (${S.items.length})?\n\nKatalog, draf, dan jadwal ikut terhapus.\nPostingan yang sudah berhasil tayang tetap disimpan di Riwayat tayang.`)) return;
    let n = 0;
    S.items.forEach((it) => { n += simpanRiwayatTayang(it); });
    S.items = [];
    syncMeta();
    log('info', `Semua produk dihapus permanen${n ? ` · ${n} postingan tayang disimpan` : ''}`);
    save(); render(); toast('Semua produk dihapus permanen');
  },

  'cfg-export'() {
    const snap = settingsSnapshot();
    download('pengaturan.js', seedText(snap), 'application/javascript');
    S.seedStamp = snap.savedAt;
    save(); render();
    toast('pengaturan.js diunduh — timpa file di folder aplikasi', 'ok');
  },

  'cfg-import'() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.js,.json,application/json,text/javascript';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const txt = String(fr.result || '')
            .replace(/^\s*window\.SAVED_SETTINGS\s*=\s*/i, '')
            .replace(/;\s*$/, '');
          const obj = JSON.parse(txt);
          if (!applySeed(obj, true)) throw new Error('struktur tidak dikenali');
          save(); render();
          toast('Pengaturan dimuat dari ' + f.name, 'ok');
        } catch (e) {
          toast('File tidak bisa dibaca: ' + e.message, 'err');
        }
      };
      fr.readAsText(f);
    };
    inp.click();
  },

  'cfg-show'() {
    const json = JSON.stringify(settingsSnapshot(), null, 2);
    openModal(`
      <div class="modal-head"><div><h3>Pengaturan (JSON)</h3><p>Isi ini yang dipakai aplikasi sekarang.</p></div></div>
      <div class="modal-body">
        <textarea class="textarea" rows="16" style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px" readonly>${esc(json)}</textarea>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" data-act="cfg-copy">Copy JSON</button>
        <button class="btn" data-close="1">Tutup</button>
      </div>`);
  },

  'cfg-copy'() {
    copyText(JSON.stringify(settingsSnapshot(), null, 2));
  },

  /* bukti bahwa data benar-benar mendarat di database: tulis, lalu baca ulang */
  'verify-save'() {
    if (STORE.mode !== 'server') {
      openModal(`
        <div class="modal-head"><div><h3>Database tidak terhubung</h3><p>Tidak ada yang bisa diperiksa.</p></div><button class="x" data-close="1">×</button></div>
        <div class="modal-body">
          <div class="hint warn">${esc(STORE.err || 'server lokal tidak menjawab')}</div>
          <div class="hint mt14">Jalankan <code>mulai.bat</code>, lalu buka <code>http://127.0.0.1:8787/</code>.
            Cek langsung dari terminal juga bisa: <code>python cek.py</code></div>
        </div>
        <div class="modal-foot"><button class="btn btn-primary" data-close="1">Mengerti</button></div>`);
      return;
    }

    openModal(`
      <div class="modal-head"><div><h3>Memeriksa penyimpanan…</h3><p>Menulis ke database lalu membacanya ulang.</p></div><button class="x" data-close="1">×</button></div>
      <div class="modal-body"><div class="tiny muted">Menunggu server…</div></div>`);

    (async () => {
      let rev = 0, at = 0, rItems = 0, rLen = 0, snaps = 0, err = '';
      try {
        await pushRemote();
        const r = await fetch(API + '/state', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        rev = j.rev || 0;
        at = j.updatedAt || 0;
        const remote = j.state || { items: [] };
        rItems = (remote.items || []).length;
        rLen = JSON.stringify(remote).length;
        const h = await fetch(API + '/history?limit=1', { cache: 'no-store' });
        if (h.ok) snaps = (await h.json()).total || 0;
      } catch (e) { err = String((e && e.message) || e); }

      const lItems = S.items.length;
      const lLen = JSON.stringify(S).length;
      const cocok = !err && lItems === rItems;

      openModal(`
        <div class="modal-head"><div><h3>${err ? 'Gagal memeriksa' : 'Data ada di database'}</h3>
          <p>${err ? 'Server tidak menjawab.' : 'Ditulis, lalu dibaca ulang dari data/affiliate.db.'}</p></div>
          <button class="x" data-close="1">×</button></div>
        <div class="modal-body">
          ${err ? `<div class="hint warn">${esc(err)}</div>` : `
            <div class="row mb14">
              <span class="badge ${cocok ? 'b-ok' : 'b-danger'}">${cocok ? 'jumlah produk cocok' : 'jumlah produk berbeda'}</span>
              <span class="badge b-gray">revisi ${rev}</span>
            </div>`}
          <div class="kv"><span>Waktu simpan di server</span><b>${at ? fmtDateTime(at) : '—'}</b></div>
          <div class="kv"><span>Produk di aplikasi</span><b>${lItems}</b></div>
          <div class="kv"><span>Produk di database</span><b>${err ? '—' : rItems}</b></div>
          <div class="kv"><span>Ukuran JSON</span><b>${lLen} vs ${err ? '—' : rLen} karakter</b></div>
          <div class="kv"><span>Snapshot tersimpan</span><b>${err ? '—' : snaps}</b></div>
          <div class="hint mt14">
            Angka ini datang dari server, bukan dari memori browser. Kalau dua baris produk sama,
            datanya sudah benar-benar tertulis di <code>data/affiliate.db</code>.
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="open-raw">Lihat JSON mentah</button>
          <button class="btn btn-primary" data-close="1">Tutup</button>
        </div>`);
    })();
  },

  'open-raw'() {
    window.open(API + '/state', '_blank');
  },

  'state-export'() {
    const payload = {
      app: 'affiliate-studio',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      origin: typeof location !== 'undefined' ? originLabel() : '',
      state: S
    };
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    download(`backup-afiliasi-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
    log('ok', `Backup dibuat: ${activeItems().length} produk`);
    save(); render();
  },

  'state-import'() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        let obj;
        try { obj = JSON.parse(String(fr.result || '{}')); } catch (e) { return toast('File bukan JSON yang valid', 'err'); }
        let next;
        try { next = restoreState(obj); } catch (e) { return toast('Backup tidak dikenali: ' + e.message, 'err'); }

        const n = next.items.length;
        const when = obj.exportedAt || (obj.state && obj.state.exportedAt) || null;
        if (!confirm(`Pulihkan ${n} produk dari backup${when ? ' (' + fmtDateTime(when) + ')' : ''}?\n\nData yang ada sekarang di database akan DIGANTI.`)) return;

        S = next;
        usedLoad(S.used);
        log('ok', `Data dipulihkan dari backup: ${n} produk`);
        save(); render();
        toast(`${n} produk dipulihkan`, 'ok');
      };
      fr.readAsText(f);
    };
    inp.click();
  },

  'export-json'() {
    const data = activeItems().map((i) => ({
      productId: i.productId, name: i.name, price: i.priceText, sold: i.soldText, shop: i.shop,
      commission: i.commText, category: i.category, affiliateUrl: i.affiliateUrl,
      threads: { posts: plat(i, 'threads').posts, status: plat(i, 'threads').status },
      tiktok: { hook: plat(i, 'tiktok').hook, scenes: plat(i, 'tiktok').scenes, caption: plat(i, 'tiktok').caption, coverText: plat(i, 'tiktok').coverText, status: plat(i, 'tiktok').status },
      schedule: { threads: plat(i, 'threads').sched, tiktok: plat(i, 'tiktok').sched }
    }));
    download('konten-afiliasi.json', JSON.stringify(data, null, 2), 'application/json');
  },

  'export-csv'() {
    const head = ['ID Produk', 'Nama Produk', 'Platform', 'Status Review', 'Jadwal', 'Status Posting', 'Percobaan', 'Error'];
    const rows = [head];
    activeItems().forEach((i) => {
      ['threads', 'tiktok'].forEach((pf) => {
        const s = plat(i, pf).sched;
        rows.push([i.productId, i.name, pf, plat(i, pf).status, s.at ? new Date(s.at).toLocaleString('id-ID') : '', s.status, s.attempts, s.lastError || '']);
      });
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
    download('jadwal-posting.csv', '\ufeff' + csv, 'text/csv');
  },

  'copy-plot'(el) {
    S.ui.copyPlot = el.dataset.plot;
    save(); render();
  },
  'copy-save'() {
    const cat = S.ui.copyCat || 'safety';
    const slots = PLOT_SLOTS[S.ui.copyPlot || 'p1'] || [];
    const box = S.copy[cat] || (S.copy[cat] = {});
    let changed = 0;
    slots.forEach((sl) => {
      const ta = document.querySelector('[data-slot="' + sl.key + '"]');
      if (!ta) return;
      const lines = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const def = defaultLines(cat, sl.key);
      if (!lines.length || lines.join('\n') === def.join('\n')) { delete box[sl.key]; return; }
      box[sl.key] = lines;
      changed++;
    });
    if (!Object.keys(box).length) delete S.copy[cat];
    clearUsed(cat);
    const n = markRegenCategory(cat);
    save(); render();
    toast(changed + ' slot disimpan · ' + n + ' konten ditandai regenerate', 'ok');
  },
  'copy-reset-plot'() {
    const cat = S.ui.copyCat || 'safety';
    const slots = PLOT_SLOTS[S.ui.copyPlot || 'p1'] || [];
    if (S.copy[cat]) {
      slots.forEach((sl) => { delete S.copy[cat][sl.key]; });
      if (!Object.keys(S.copy[cat]).length) delete S.copy[cat];
    }
    clearUsed(cat);
    const n = markRegenCategory(cat);
    save(); render();
    toast('Plot dikembalikan ke default · ' + n + ' konten ditandai regenerate', 'ok');
  },
  'copy-reset-all'() {
    if (!confirm('Kembalikan semua bank kalimat ke teks default? Editan prompt akan hilang.')) return;
    S.copy = {};
    Array.from(_usedLines.keys()).forEach((k) => _usedLines.delete(k));
    const n = markRegenCategory(null);
    save(); render();
    toast('Semua plot kembali ke default · ' + n + ' konten ditandai regenerate', 'ok');
  },
  'ai-test'() {
    const cfg = aiCfg();
    const box = document.querySelector('[data-aitest]');
    const put = (msg) => { if (box) box.textContent = msg; };
    if (!cfg.model) { put('✕ model belum diisi'); return; }
    if (!cfg.key && !cfg.baseUrl) { put('✕ isi API key atau Base URL dulu'); return; }
    const proto = llmProtocol(cfg);
    put('menguji ' + llmEndpoint(cfg, proto) + ' …');
    const t0 = Date.now();
    callLLM(cfg, 'Balas dengan satu kata: OK', 'Tes koneksi. Balas: OK', 25000)
      .then((out) => {
        const ms = Date.now() - t0;
        put('✓ tersambung · ' + ms + 'ms · ' + proto + ' · "' + out.replace(/\s+/g, ' ').slice(0, 30) + '"');
        toast('Koneksi ' + (AI_PRESETS[cfg.provider] || {}).label + ' berhasil', 'ok');
      })
      .catch((e) => { put('✕ ' + e.message); toast(e.message, 'err'); });
  },
  'ai-gen'(el) {
    const pf = el.dataset.pf;
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di kartu Generator LLM', 'err'); return; }
    const list = activeItems().filter((i) => !hasContent(i, pf));
    if (!list.length) { toast('Tidak ada draf yang perlu dibuat — semua sudah punya konten', ''); return; }
    openProgress([{ pf, list }]);
  },
  'ai-one'(el) {
    const pf = el.dataset.pf;
    if (!aiReady()) { toast('Isi konfigurasi LLM dulu di Pengaturan', 'err'); return; }
    const it = findItem(el.dataset.key);
    if (!it) return;
    const jalan = () => {
      el.disabled = true;
      el.textContent = '…';
      generateFor(pf, [it]).then((r) => {
        save(); render();
        toast(r.ok ? 'Konten dibuat dengan LLM' + (r.moved ? ' · filter ke Semua' : '') : 'Gagal: ' + r.lastErr, r.ok ? 'ok' : 'err');
      });
    };
    if (!draftReady(it)) { askProceed('Tetap generate', jalan); return; }
    jalan();
  },
  'ai-clear'() {
    if (!confirm('Hapus API key LLM yang tersimpan di browser ini?')) return;
    aiCfg().key = '';
    save(); render();
    toast('API key dihapus', 'ok');
  },
  'open-server'() {
    location.href = SERVER_ORIGIN + '/';
  },
  'retry-connect'() {
    STORE.mode = 'connecting';
    STORE.ready = false;
    STORE.err = '';
    render();
    initStore();
  },
  'reload-remote'() {
    if (!confirm('Muat ulang dari database?\n\nPerubahan yang dibuat di tab ini sejak terakhir tersimpan akan hilang.')) return;
    STORE.conflict = 0;
    STORE.mode = 'connecting';
    STORE.err = '';
    render();
    initStore();
  },
  reset() {
    if (!confirm('Reset semua data ke kondisi awal? Konten, jadwal, dan log akan hilang dari database.')) return;
    _usedLines.clear();            // rotasi kalimat juga ikut direset
    S = initialState();
    save(); render(); toast('Data direset', 'ok');
  }
};

function findItem(key) { return S.items.find((i) => i.key === key); }

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('File diunduh', 'ok');
}

/* ---------------- video siap posting ----------------
   Hasil generator video (Gemini/Veo) diunggah ke sini, bukan ditempel ke
   caption. Server menyimpannya di data/video/<key>/ dan menyajikannya lewat
   /api/video dengan dukungan Range — jadi player bisa di-scrub tanpa
   mengunduh seluruh file lebih dulu. */

/* nama folder mengikuti aturan server.py (_SAFE_KEY); dipakai hanya untuk
   mencocokkan daftar file di disk dengan state, bukan untuk menulis path. */
function _mediaDirName(key) {
  return String(key || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
}

/* terapkan daftar file yang benar-benar ada di disk ke state satu produk.
   true = state berubah (perlu disimpan). */
function applyDiskList(item, onDisk) {
  const m = mediaOf(plat(item, 'tiktok'));
  const have = new Set(m.videos.map((v) => v.file));
  const disk = new Set(onDisk.map((f) => f.file));
  let changed = false;
  m.videos = m.videos.filter((v) => {          // file dihapus manual dari folder
    if (disk.has(v.file)) return true;
    changed = true;
    return false;
  });
  onDisk.forEach((f) => {                      // file ditaruh manual ke folder
    if (have.has(f.file)) return;
    m.videos.push({ file: f.file, name: f.file, size: f.size, at: f.at });
    changed = true;
  });
  m.videos.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!m.videos.some((v) => v.file === m.pick)) {
    m.pick = m.videos.length ? m.videos[m.videos.length - 1].file : '';
    changed = true;
  }
  return changed;
}

/* null = server tidak menjawab: pemanggil tidak boleh mengubah state. */
async function videoDiskList() {
  try {
    const r = await fetch('/api/videos', { cache: 'no-store' });
    const j = await r.json();
    return (j && j.items) || {};
  } catch (e) {
    return null;
  }
}

async function syncVideos(item) {
  const all = await videoDiskList();
  if (!all) return false;
  const onDisk = all[_mediaDirName(item.key)];
  if (!onDisk) return false;
  return applyDiskList(item, onDisk);
}

/* Dipanggil sekali setiap aplikasi dimuat. Alasannya konkret: kalau tab
   ditutup/di-reload sebelum balasan unggahan sampai (atau sebelum penulisan
   state yang di-debounce 400 ms jalan), filenya sudah ada di disk tapi state
   tidak pernah tahu. Tanpa rekonsiliasi ini daftar bilang "tanpa video"
   padahal filenya ada — dan user tidak punya cara memperbaikinya sendiri. */
async function reconcileVideos() {
  const all = await videoDiskList();
  if (!all) return;
  let changed = false;
  let passed = 0;
  let blocked = 0;
  activeItems().forEach((it) => {
    const onDisk = all[_mediaDirName(it.key)];
    if (!onDisk) return;
    if (applyDiskList(it, onDisk)) changed = true;
    /* Video yang ditaruh dari luar aplikasi (skill/CLI) juga berarti konten
       sudah disetujui — samakan dengan jalur unggah lewat UI. */
    if (pickedVideo(it, 'tiktok')) {
      const r = autoLolosAfterVideo(it);
      if (r.ok) { changed = true; passed++; }
      else if (r.reasons) blocked++;
    }
  });
  if (changed) { save(); render(); }
  if (passed) toast(`${passed} produk otomatis lolos karena videonya sudah ada`, 'ok');
  /* Diam saja saat tertahan itu menyesatkan: videonya kelihatan siap, tapi
     statusnya tidak berubah dan user tidak tahu sebabnya. */
  if (blocked) toast(`${blocked} produk punya video tapi belum bisa lolos — kontennya belum memenuhi aturan`, '');
}

/* XHR, bukan fetch: hanya XHR yang memberi progres unggah. File 20–40 MB butuh
   umpan balik, kalau tidak tombolnya terasa mati. */
function videoUpload(key, file, onProg) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/video?key=' + encodeURIComponent(key), true);
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));  // header HTTP tidak boleh non-ASCII
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProg) onProg(e.loaded / e.total); };
    x.onload = () => {
      let j = null;
      try { j = JSON.parse(x.responseText || '{}'); } catch (err) { j = null; }
      if (x.status >= 200 && x.status < 300 && j && j.ok) resolve(j);
      else reject(new Error((j && j.error) || 'Unggah gagal (' + x.status + ')'));
    };
    x.onerror = () => reject(new Error('Server tidak menjawab — pastikan server.py jalan'));
    x.onabort = () => reject(new Error('Unggahan dibatalkan'));
    x.send(file);
  });
}

/* Unggah video = konten disetujui. Tapi gerbang validasi tetap dihormati:
   kalau kontennya memang melanggar aturan (hook kosong, scene kurang dari 3,
   frasa terlarang), jangan diloloskan diam-diam — beri tahu alasannya supaya
   tidak terlihat seperti bug.

   `batal` sengaja TIDAK dihidupkan: pembatalan itu keputusan sadar user, bukan
   sesuatu yang boleh dibatalkan oleh file video yang kebetulan ada. */
function autoLolosAfterVideo(item) {
  const p = plat(item, 'tiktok');
  if (p.status === 'lolos') return { ok: false, why: 'sudah' };
  if (p.status === 'batal') return { ok: false, why: 'batal' };
  const v = validateContent(item, 'tiktok');
  if (!v.ok) return { ok: false, why: 'tidak valid', reasons: v.reasons };
  p.status = 'lolos';
  p.updatedAt = Date.now();
  autoSchedule(item, 'tiktok');
  log('ok', `Video ada — ${String(item.name).slice(0, 30)}… otomatis lolos review (TikTok)`);
  return { ok: true };
}

async function uploadVideoFor(item, file) {
  if (!/\.(mp4|mov|webm|m4v)$/i.test(file.name) && !/^video\//i.test(file.type || '')) {
    return toast('File harus video (mp4, mov, webm)', 'err');
  }
  if (file.size > 200 * 1024 * 1024) return toast('Maksimal 200 MB', 'err');

  const drop = document.querySelector('[data-vdrop]');
  const prog = document.querySelector('[data-vprog]');
  if (drop) drop.dataset.busy = '1';
  if (prog) { prog.hidden = false; prog.firstElementChild.style.width = '0%'; }
  try {
    const j = await videoUpload(item.key, file, (p) => {
      if (prog) prog.firstElementChild.style.width = Math.round(p * 100) + '%';
    });
    const m = mediaOf(plat(item, 'tiktok'));
    m.videos.push({
      file: j.file,
      name: String(file.name).slice(0, 120),
      size: j.size || file.size,
      at: Date.now()
    });
    m.pick = j.file;                       // unggahan terbaru langsung dipakai
    const pass = autoLolosAfterVideo(item);
    render(); refreshMediaList(item);
    /* Unggah itu tindakan langka dan mahal — jangan gantungkan hasilnya pada
       debounce 400 ms. Kalau tab di-reload tepat setelah unggahan selesai,
       state-nya hilang dan filenya jadi yatim. */
    save();
    await pushRemote();
    log('ok', `Video ${file.name} diunggah untuk ${item.name.slice(0, 30)}…`);
    if (pass.ok) toast('Video siap posting · konten otomatis lolos review', 'ok');
    else if (pass.reasons) toast('Video siap · belum lolos: ' + pass.reasons.slice(0, 2).join(' · '), '');
    else toast('Video siap posting', 'ok');
  } catch (e) {
    toast(String((e && e.message) || e), 'err');
  } finally {
    if (drop) delete drop.dataset.busy;
    if (prog) { prog.hidden = true; prog.firstElementChild.style.width = '0%'; }
  }
}

async function deleteVideoFile(item, file) {
  try {
    const r = await fetch('/api/video?key=' + encodeURIComponent(item.key) + '&file=' + encodeURIComponent(file), { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error((j && j.error) || 'Gagal menghapus (' + r.status + ')');
    }
  } catch (e) {
    toast(String((e && e.message) || e), 'err');
    return false;
  }
  const m = mediaOf(plat(item, 'tiktok'));
  m.videos = m.videos.filter((v) => v.file !== file);
  if (m.pick === file) m.pick = m.videos.length ? m.videos[m.videos.length - 1].file : '';
  render(); refreshMediaList(item);
  save();
  await pushRemote();                      // alasan sama: jangan menunggu debounce
  toast('Video dihapus');
  return true;
}

/* Penanda video untuk daftar ringkas (baris yang belum dibuka) dan tabel
   Penjadwalan. Tanpa ini, status "siap posting" hanya kelihatan setelah kartu
   dibuka — padahal itu justru informasi yang dicari saat memindai daftar.
   `warn` dipakai di Penjadwalan karena di sana video memang prasyarat posting. */
function videoBadge(item, pf, opts) {
  if (pf !== 'tiktok') return '';
  const v = pickedVideo(item, pf);
  if (v) {
    return `<span class="badge b-ok" title="Video siap posting — ${esc(v.name || v.file)}">video siap</span>`;
  }
  if (opts && opts.hideMissing) return '';
  return `<span class="badge ${opts && opts.warn ? 'b-warn' : 'b-gray'}" title="Belum ada file video yang diunggah untuk produk ini">tanpa video</span>`;
}

/* strip ringkas di kartu TikTok: satu player + status siap posting */
function videoStrip(item) {
  const m = mediaOf(plat(item, 'tiktok'));
  const v = pickedVideo(item, 'tiktok');
  if (!v) {
    return `<div class="vstrip is-empty">
      <div class="vstrip-meta">
        <div class="vstrip-t">Video belum diunggah</div>
        <div class="tiny muted">TikTok butuh file video. Unggah hasil generate di sini supaya ikut terbawa saat posting.</div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-sm" data-act="video-media" data-key="${item.key}">Unggah video</button>
    </div>`;
  }
  return `<div class="vstrip">
    <video class="vstrip-v" src="${videoUrl(item.key, v.file)}" controls preload="metadata" playsinline></video>
    <div class="vstrip-meta">
      <div class="vstrip-t"><span class="badge b-ok">siap posting</span> <span class="vstrip-f">${esc(v.name || v.file)}</span></div>
      <div class="tiny muted">${fmtBytes(v.size || 0)} · ${fmtDateTime(v.at)}${m.videos.length > 1 ? ` · ${m.videos.length} versi tersimpan` : ''}</div>
    </div>
    <div class="spacer"></div>
    <button class="btn btn-sm btn-ghost" data-act="video-media" data-key="${item.key}">Kelola</button>
  </div>`;
}

function videoRowHtml(item, v, sel) {
  const url = videoUrl(item.key, v.file);
  return `<div class="vrow ${sel ? 'sel' : ''}">
    <video class="vrow-v" src="${url}" preload="metadata" controls playsinline></video>
    <div class="vrow-meta">
      <div class="vrow-name" title="${esc(v.file)}">${esc(v.name || v.file)}</div>
      <div class="tiny muted">${fmtBytes(v.size || 0)} · ${fmtDateTime(v.at)}</div>
      ${sel ? '<span class="badge b-ok">dipakai</span>' : ''}
    </div>
    <div class="vrow-act">
      <button class="btn btn-xs ${sel ? 'btn-ok' : ''}" data-act="vuse" data-key="${item.key}" data-file="${esc(v.file)}" ${sel ? 'disabled' : ''}>${sel ? '✓ Dipakai' : 'Pakai'}</button>
      <a class="btn btn-xs btn-ghost" href="${url}" download="${esc(v.name || v.file)}">Unduh</a>
      <button class="btn btn-xs btn-danger" data-act="vdel" data-key="${item.key}" data-file="${esc(v.file)}">Hapus</button>
    </div>
  </div>`;
}

function mediaListHtml(item) {
  const m = mediaOf(plat(item, 'tiktok'));
  if (!m.videos.length) {
    return `<div class="empty" style="padding:20px 0">
      <h4>Belum ada video</h4>
      <p>Unggah hasil generate di atas. Yang di sini hanya file videonya — caption tetap disalin terpisah saat posting.</p>
    </div>`;
  }
  return m.videos.slice().reverse().map((v) => videoRowHtml(item, v, v.file === m.pick)).join('');
}

function refreshMediaList(item) {
  const box = document.querySelector('[data-vlist]');
  if (box) box.innerHTML = mediaListHtml(item);
}

async function openMediaModal(item) {
  const dir = _mediaDirName(item.key);
  openModal(`
    <div class="modal-head">
      <div><h3>Video siap posting</h3><p>${esc(String(item.name).slice(0, 70))}</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      <div class="vdrop" data-vdrop="1" data-key="${item.key}">
        <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v" data-vfile="1" data-key="${item.key}" hidden>
        <div class="vdrop-main">
          <div>
            <b>Unggah hasil generate</b>
            <div class="tiny muted">MP4 · MOV · WEBM, maksimal 200 MB. Bisa juga tarik-lepas filenya ke sini.</div>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" data-act="vpick">Pilih file</button>
        </div>
        <div class="vprog" data-vprog="1" hidden><i></i></div>
      </div>
      <div class="vlist" data-vlist="1">${mediaListHtml(item)}</div>
    </div>
    <div class="modal-foot">
      <span class="tiny muted">Tersimpan di <code>data/video/${esc(dir)}/</code></span>
      <div class="spacer"></div>
      <button class="btn" data-close="1">Tutup</button>
    </div>`);
  const changed = await syncVideos(item);      // file dihapus/ditaruh manual di folder
  if (changed) { save(); render(); refreshMediaList(item); }
}

/* ---------------- modal ---------------- */
function openModal(html, onMount) {
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal" role="dialog">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  if (onMount) onMount($('.modal'));
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  document.body.style.overflow = '';
}

/* pratinjau import: tunjukkan dampaknya sebelum satu baris pun diubah */
function openImportModal(plan) {
  _pendingImport = plan;                 // tombol "Terapkan" membaca rencana ini
  const chg = {};
  plan.updated.forEach((u) => u.changes.forEach((c) => { chg[c] = (chg[c] || 0) + 1; }));
  const chgTxt = Object.keys(chg).map((k) => `${chg[k]} ${k}`).join(' · ') || 'tidak ada perubahan isi';
  const changed = plan.updated.filter((u) => u.changes.length);
  const frozen = changed.filter((u) => isFrozen(u.item));
  const tag = (c) => `<span class="badge b-gray" style="margin-right:4px">${esc(c)}</span>`;

  openModal(`
    <div class="modal-head"><div><h3>Pratinjau import · batch ${esc(plan.batch)}</h3><p>Belum ada yang diubah. Periksa dulu, baru terapkan.</p></div><button class="x" data-close="1">×</button></div>
    <div class="modal-body">
      <div class="kv"><span>Produk baru</span><b>${plan.added.length}</b></div>
      <div class="kv"><span>Sudah ada · diperbarui</span><b>${plan.updated.length}</b></div>
      <div class="kv"><span>Isi katalog berubah</span><b>${changed.length}</b></div>
      ${plan.dupes ? `<div class="kv"><span>Duplikat di file (dilewati)</span><b>${plan.dupes}</b></div>` : ''}
      ${plan.invalid ? `<div class="kv"><span>Baris tidak valid</span><b>${plan.invalid}</b></div>` : ''}

      ${changed.length ? `
        <div class="hint mt14"><b>Perubahan katalog:</b> ${esc(chgTxt)}</div>
        <div class="stack mt8" style="max-height:150px;overflow:auto">
          ${changed.slice(0, 6).map((u) => `<div class="tiny">${esc(u.k.name.slice(0, 44))} <span class="muted">— ${u.changes.map(tag).join('')}</span></div>`).join('')}
          ${changed.length > 6 ? `<div class="tiny muted">+${changed.length - 6} produk lain</div>` : ''}
        </div>` : ''}

      ${frozen.length ? `<div class="hint warn mt14"><b>${frozen.length} konten sudah lolos / tayang.</b> Katalognya tetap diperbarui, tapi konten & jadwalnya <b>tidak</b> disentuh — riwayat posting tetap utuh.</div>` : ''}

    </div>
    <div class="modal-foot">
      <button class="btn" data-act="import-cancel">Batal</button>
      <button class="btn btn-primary" data-act="import-commit">Terapkan import</button>
    </div>`);
}

function openDetail(it) {
  if (!it) return;
  const d = it.detail || null;
  const all = assetsOf(it);
  const imgs = all.filter((a) => a.kind === 'image' && !/-thumb\.jpg$/i.test(a.file));
  const vids = all.filter((a) => a.kind === 'video');
  const specs = d
    ? String(d.specs || '').split('|').map((s) => s.trim())
        .filter((s) => s && !/tidak garansi|belum ada/i.test(s))
    : [];
  const banner = d
    ? (String(d.raw_description || '').match(/https:\/\/down-id\.img\.susercontent\.com\/file\/[\w-]+/g) || [])
    : [];

  openModal(`
    <div class="modal-head">
      <div><h3>Detail produk</h3><p>${esc(it.name.slice(0, 70))}</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      <div class="row" style="gap:6px;margin-bottom:4px">
        <span class="chip">${d ? 'teks lengkap' : 'teks belum ada'}</span>
        <span class="chip">${imgs.length} gambar</span>
        <span class="chip">${vids.length} video</span>
        <span class="chip">ID ${esc(d && d.item_id ? d.item_id : it.productId)}</span>
      </div>

      <div class="det-k mt14">Teks produk</div>
      ${d ? `
        <div class="det-chips">${specs.map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="tiny muted">—</span>'}</div>
        <div class="det-k mt14">Stok varian</div>
        <div class="det-v">${esc(d.variations || '—')}</div>
        <div class="det-k mt14">Catatan logistik</div>
        <div class="det-v">${esc(d.logistics || '—')}</div>
        <div class="det-k mt14">Deskripsi penjual</div>
        <div class="det-desc">${esc(d.raw_description || '—')}</div>
      ` : `<div class="hint warn">Belum ada data detail. Tombol <b>Ambil detail + media</b> di tab Data Produk mengambilnya langsung dari Shopee.</div>`}

      <div class="det-k mt14">Gambar (${imgs.length})</div>
      ${imgs.length ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px">
          ${imgs.map((a) => `<a href="${assetUrl(it, a.file)}" target="_blank" rel="noopener"><img src="${assetUrl(it, a.file)}" alt="${esc(a.file)}" loading="lazy" style="width:100%;border-radius:8px;display:block"></a>`).join('')}
        </div>` : `<div class="tiny muted">Belum ada gambar di <code>assets/${esc(it.productId)}/</code>.</div>`}

      <div class="det-k mt14">Video (${vids.length})</div>
      ${vids.length ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${vids.map((v) => `<video src="${assetUrl(it, v.file)}" controls preload="metadata" style="width:240px;border-radius:8px;background:#000"></video>`).join('')}
        </div>` : `<div class="tiny muted">Produk ini tidak punya video di halaman Shopee.</div>`}

      ${banner.length ? `<div class="det-k mt14">Banner di deskripsi (${banner.length})</div>
        <div class="row">${banner.slice(0, 8).map((u, n) => `<a class="btn btn-xs" href="${esc(u)}" target="_blank" rel="noopener">Banner ${n + 1} ↗</a>`).join('')}</div>` : ''}
    </div>
    <div class="modal-foot">
      ${d ? `<button class="btn btn-ghost" data-act="detail-clear" data-key="${it.key}">Hapus detail</button>` : ''}
      <button class="btn" data-close="1">Tutup</button>
      <a class="btn btn-primary" href="${esc(it.productUrl || it.affiliateUrl)}" target="_blank" rel="noopener">Buka di Shopee ↗</a>
    </div>`);
}

function openPreview(it, pf) {
  if (!it) return;
  if (pf === 'threads') {
    const posts = plat(it, 'threads').posts || [];
    openModal(`
      <div class="modal-head">
        <div><h3>Preview utas Threads</h3><p>${posts.length} post · tiap post maksimal 500 karakter</p></div>
        <button class="x" data-close="1">×</button>
      </div>
      <div class="modal-body">
        <div class="thread-preview">
          ${posts.map((p, idx) => `
            <div class="tp-item">
              <div class="tp-meta">
                <span>Post ${idx + 1}</span>
                <span class="${p.length > 500 ? 'over' : ''}">${p.length}/500</span>
              </div>
              <div class="mock-threads">
                <div class="u"><div class="av"></div><div><b style="font-size:12px">${esc(it.shop)}</b><div class="tiny muted">baru saja</div></div></div>
                ${esc(p)}
              </div>
              <button class="btn btn-xs" data-act="copy-post" data-key="${it.key}" data-idx="${idx}">Salin post ${idx + 1}</button>
            </div>`).join('<div class="tp-sep">-----</div>')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close="1">Tutup</button>
        <button class="btn btn-primary" data-act="copy" data-key="${it.key}" data-pf="threads">Salin semua utas</button>
      </div>`);
    return;
  }

  const t = plat(it, 'tiktok');
  openModal(`
    <div class="modal-head">
      <div><h3>Preview TikTok</h3><p>${esc(t.duration || '24 detik')} · ${esc(t.music || '')}</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      <div class="phone-wrap">
        <div class="phone">
          <div class="phone-screen">
            <div class="phone-top"><span>9:41</span><span>▮▮▮</span></div>
            <div class="phone-center">
              <div class="big" style="white-space:pre-line">${esc(t.coverText || t.hook)}</div>
              <div class="sub">${esc(it.shop)} · ${esc(it.priceText)}</div>
            </div>
            <div class="phone-cap">${esc((t.hook || '').slice(0, 70))}</div>
            <div class="phone-bottom">
              <div class="u">@${esc(it.shop.toLowerCase().replace(/[^a-z0-9]/g, ''))}</div>
              <div>${esc((t.caption || '').split('\n').slice(0, 2).join(' ').slice(0, 80))}…</div>
              <div class="phone-tags">${(t.hashtags || []).slice(0, 4).map((h) => '#' + esc(h)).join(' ')}</div>
            </div>
          </div>
        </div>
        <div style="flex:1;min-width:240px">
          <div class="section-title" style="margin-top:0">Storyboard</div>
          ${sceneBlock(t.scenes)}
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">Tutup</button>
      <button class="btn" data-act="video-prompt" data-key="${it.key}">Prompt video</button>
      <button class="btn btn-primary" data-act="copy" data-key="${it.key}" data-pf="tiktok">Salin caption</button>
    </div>`);
}

function openPostModal(it, pf) {
  const content = pf === 'threads' ? threadText(it) : plat(it, 'tiktok').caption;
  const link = it.affiliateUrl;
  const vid = pf === 'tiktok' ? pickedVideo(it, 'tiktok') : null;
  openModal(`
    <div class="modal-head">
      <div><h3>Posting manual · ${pf === 'threads' ? 'Threads' : 'TikTok'}</h3><p>${esc(it.name.slice(0, 60))}</p></div>
      <button class="x" data-close="1">×</button>
    </div>
    <div class="modal-body">
      ${pf === 'tiktok' ? (vid
        ? `<div class="vstrip mb14">
            <video class="vstrip-v" src="${videoUrl(it.key, vid.file)}" controls preload="metadata" playsinline></video>
            <div class="vstrip-meta">
              <div class="vstrip-t"><span class="badge b-ok">video siap</span> <span class="vstrip-f">${esc(vid.name || vid.file)}</span></div>
              <div class="tiny muted">${fmtBytes(vid.size || 0)} · unggah ke TikTok dari file ini</div>
            </div>
            <div class="spacer"></div>
            <a class="btn btn-sm" href="${videoUrl(it.key, vid.file)}" download="${esc(vid.name || vid.file)}">Unduh</a>
          </div>`
        : `<div class="hint warn mb14">Belum ada file video untuk produk ini. <button class="btn btn-xs" data-act="video-media" data-key="${it.key}">Unggah video</button></div>`) : ''}
      <div class="field">
        <div class="field-label"><span>Caption siap tempel</span></div>
        <textarea class="textarea" rows="8" readonly>${esc(content)}</textarea>
      </div>
      <div class="row">
        <button class="btn btn-sm" data-act="copy" data-key="${it.key}" data-pf="${pf}">Salin caption</button>
        <button class="btn btn-sm" data-copy="${esc(link)}">Salin link afiliasi</button>
        <a class="btn btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Buka link ↗</a>
      </div>
      <div class="hint mt14">Setelah posting di aplikasi, tandai hasilnya di bawah supaya status antrian ikut terupdate.</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">Nanti</button>
      <button class="btn btn-danger" data-act="mark-fail" data-key="${it.key}" data-pf="${pf}">Gagal · coba lagi</button>
      <button class="btn btn-ok" data-act="mark-ok" data-key="${it.key}" data-pf="${pf}">Tandai berhasil</button>
    </div>`);
}

/* ---------------- events ---------------- */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('overlay')) { closeModal(); return; }
  const closeEl = e.target.closest('[data-close]');
  if (closeEl) { closeModal(); return; }

  const cp = e.target.closest('[data-copy]');
  if (cp) { copyText(cp.dataset.copy); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

/* Ingat baris mana yang sedang terbuka, supaya aksi seperti "Lolos" atau
   "Regenerate" (yang memicu render ulang) tidak menutup editor yang aktif.
   Hanya di memori — tidak menulis database. */
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d || !d.matches) return;
  if (d.matches('details.rrow')) {
    const key = d.dataset.rkey;
    if (!key) return;
    if (d.open) _revOpen.add(key); else _revOpen.delete(key);
    return;
  }
  if (d.matches('details.det[data-det]')) {
    const key = d.dataset.det;
    if (!key) return;
    if (d.open) _detOpen.add(key); else _detOpen.delete(key);
  }
}, true);

/* pilih penyedia di popup -> isi Base URL & model yang lazim dipakai */
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || t.id !== 'setup-provider') return;
  const p = AI_PRESETS[t.value] || {};
  const b = document.getElementById('setup-base');
  const m = document.getElementById('setup-model');
  if (b) b.value = p.base || '';
  if (m) m.value = (p.models && p.models[0]) || '';
  const msg = document.querySelector('[data-setup-msg]');
  if (msg) msg.textContent = '';
});

document.addEventListener('input', (e) => {
  const t = e.target;

  /* setelan LLM lokal: tinggal di browser, jadi TIDAK memanggil save()
     (save() menulis ke database server). */
  if (t.matches('[data-ls]')) {
    const j = lsLlmGet() || { enabled: true };
    j[t.dataset.ls] = t.value;
    lsLlmSet(j);
    return;
  }

  if (t.matches('[data-ai]')) {
    const field = t.dataset.ai;
    const c = aiCfg();
    c[field] = t.value;
    if (field === 'provider') {
      const preset = AI_PRESETS[c.provider] || AI_PRESETS.gemini;
      c.model = (preset.models && preset.models[0]) || '';
      c.baseUrl = '';
      save(); render();
      return;
    }
    save();
    return;
  }

  if (t.matches('[data-copysel="cat"]')) {
    S.ui.copyCat = t.value;
    save(); render();
    return;
  }

  if (t.matches('textarea[data-slot]')) {
    const counter = t.parentElement.querySelector('.counter');
    if (counter) counter.textContent = t.value.split('\n').filter((x) => x.trim()).length + ' varian';
    return;
  }

  if (t.matches('textarea[data-edit]')) {
    const it = findItem(t.dataset.key);
    if (!it) return;
    const seg = t.dataset.edit.split('.');
    const pf = seg[0], field = seg[1];
    if (pf === 'threads' && field === 'posts') plat(it, 'threads').posts[+seg[2]] = t.value;
    else plat(it, pf)[field] = t.value;
    plat(it, pf).updatedAt = Date.now();

    const counter = t.parentElement.querySelector('.counter');
    if (counter) {
      const n = t.value.length;
      if (pf === 'threads') {
        counter.textContent = `${n}/500`;
        counter.classList.toggle('over', n > 500);
      } else if (field === 'hook') counter.textContent = n;
      else counter.textContent = `${n}/2200`;
    }
    clearTimeout(t._tm);
    t._tm = setTimeout(save, 400);
    return;
  }

  if (t.matches('[data-sched]')) {
    const [key, pf] = t.dataset.sched.split('|');
    const it = findItem(key);
    if (!it) return;
    /* nilai input dibaca sebagai jam AUDIENS, bukan jam perangkat */
    const at = fromAudienceInput(t.value);
    plat(it, pf).sched.at = at;
    plat(it, pf).sched.gaveUp = false;
    if (plat(it, pf).sched.status === 'berhasil posting') plat(it, pf).sched.status = 'belum post';
    /* keterangan di bawah input diperbarui di tempat — render() penuh akan
       menutup pemilih tanggal yang sedang dibuka */
    const noteEl = t.parentElement.querySelector('.tiny');
    if (noteEl) noteEl.textContent = at ? (primeNote(pf, at) || 'manual · di luar jam prime') : 'belum dijadwalkan';
    save(); toast('Jadwal diperbarui');
    return;
  }

  if (t.matches('[data-plot]')) {
    const it = findItem(t.dataset.plot);
    if (!it) return;
    const p = plat(it, 'threads');
    p.plot = t.value;
    it.plot = t.value;          // plot default ikut diselaraskan
    p.status = 'belum review';
    save(); render();
    if (!aiReady()) {
      toast('Plot diganti ke ' + PLOTS[t.value].name + ' — isi konfigurasi LLM untuk menulis ulang', 'err');
      return;
    }
    toast('Plot diganti ke ' + PLOTS[t.value].name + ' — menulis ulang dengan LLM…');
    generateFor('threads', [it]).then((r) => {
      save(); render();
      toast(r.ok ? 'Utas ditulis ulang dengan plot ' + PLOTS[t.value].name : 'Gagal menulis ulang: ' + r.lastErr, r.ok ? 'ok' : 'err');
    });
    return;
  }

  if (t.matches('[data-set]')) {
    const k = t.dataset.set;
    let v = t.type === 'radio' ? t.value : (t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value);
    if (k === 'mode') v = t.value;
    S.settings[k] = v;
    save();
    if (k === 'failRate') {
      const lbl = t.parentElement.querySelector('.counter');
      if (lbl) lbl.textContent = v + '%';
    }
    /* ganti zona audiens harus langsung menggambar ulang: label & keterangan ikut berubah */
    if (k === 'tzAudience' || k === 'mode') { renderNav(); render(); }
  }
});

/* ---------------- unggah video: input file + tarik-lepas ---------------- */
document.addEventListener('change', (e) => {
  const t = e.target;
  /* jam puncak: gambar ulang setelah nilainya dikomit, supaya keterangan di
     bawahnya ikut berubah tanpa merebut fokus saat masih mengetik */
  if (t.matches && t.matches('[data-set]') && /^hour(Threads|Tiktok)2?$/.test(t.dataset.set)) {
    render();
    return;
  }
  if (!t.matches || !t.matches('[data-vfile]')) return;
  const it = findItem(t.dataset.key);
  const f = t.files && t.files[0];
  t.value = '';                       // supaya file yang sama bisa dipilih lagi setelah gagal
  if (it && f) uploadVideoFor(it, f);
});

['dragenter', 'dragover'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    const z = e.target.closest && e.target.closest('[data-vdrop]');
    if (!z) return;
    e.preventDefault();               // tanpa ini browser membuka file-nya
    z.classList.add('over');
  });
});

document.addEventListener('dragleave', (e) => {
  const z = e.target.closest && e.target.closest('[data-vdrop]');
  if (z && !z.contains(e.relatedTarget)) z.classList.remove('over');
});

document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('[data-vdrop]');
  if (!z) return;
  e.preventDefault();
  z.classList.remove('over');
  const it = findItem(z.dataset.key);
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (it && f) uploadVideoFor(it, f);
});

/* ---------------- scheduler loop ---------------- */
setInterval(() => {
  if (!S.ui.running || S.settings.mode !== 'simulasi') return;
  const now = Date.now();
  let changed = false;
  activeItems().forEach((it) => {
    ['threads', 'tiktok'].forEach((pf) => {
      const s = plat(it, pf).sched;
      if (s.status === 'belum post' && s.at && s.at <= now && plat(it, pf).status === 'lolos' && !s.gaveUp) {
        attemptPost(it, pf);
        changed = true;
      }
    });
  });
  if (changed) { save(); render(); }
}, 4000);

/* ---------------- init ---------------- */
if (SEED_NOTE) log('info', SEED_NOTE);
render();              // tampilkan layar "menghubungkan…" dulu
probeServerLlm().then(maybeLlmSetup);   // tanya apakah key LLM diurus server (VPS)
initStore();           // lalu ambil state dari database; tanpa fallback lokal
/* Sumber detail produk: kalau server menyatakan tidak bisa (IP datacenter,
   akses Shopee Open API belum ada), UI menampilkan keterangan — bukan
   tombol yang gagal tanpa sebab. */
probeShopee().then((cap) => { if (cap && cap.available === false) render(); });
