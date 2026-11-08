/* ============================================================
   AGENTS.JS — orkestrasi tiga agent untuk satu draf konten
   ------------------------------------------------------------
   Planner  : membaca product sheet, menyusun brief + batas klaim.
   Writer   : menulis draf dari brief. Tidak berwenang menilai.
   Reviewer : menilai draf terhadap RULEBOOK, mengutip ID aturan.

   Aturan main:
   - Reviewer punya DUA lapis. Lapis 1 adalah mesin aturan deterministik
     (ruleScan) yang tidak bisa dibujuk prompt. Lapis 2 adalah LLM yang
     menangkap pelanggaran yang tidak tertangkap pola. Kalau keduanya
     berselisih, lapis 1 menang untuk aturan severity "block".
   - Writer tidak pernah melihat "lulus". Dia hanya menerima daftar
     pelanggaran. Yang menyatakan lulus adalah Reviewer.
   - Maksimal 3 iterasi. Kalau masih melanggar, pipeline berhenti dan
     menyerahkan sisanya ke manusia. Tidak ada perulangan tanpa batas.
   ============================================================ */

const AGENT_MAX_ITER = 3;

function rbRules() { return (window.RULEBOOK && window.RULEBOOK.rules) || []; }
function rbRule(id) { return rbRules().find((r) => r.id === id) || null; }
function rbRulesFor(pf, kind) {
  return rbRules().filter((r) => (r.applies || []).indexOf(pf) >= 0 && (!kind || r.kind === kind));
}

/* ---------- sumber fakta ----------
   Semua yang boleh diklaim Writer harus berasal dari sini. Tidak ada
   pengetahuan lain yang diizinkan masuk. */
function sourceText(item) {
  const d = (item && item.detail) || {};
  return [
    item.name, item.variant, item.shop, item.category,
    item.priceText, item.soldText, item.commText, item.commRate,
    d.title, d.specs, d.features, d.variations, d.logistics,
    d.shop_location, d.raw_description
  ].filter(Boolean).join('\n');
}

/* Sumber yang boleh dibaca Planner dan Writer: klaim terlarang milik penjual
   dibuang lebih dulu. Bukan karena mereka tidak dilarang memakainya, tapi
   karena apa pun yang mereka baca cenderung muncul lagi di brief lalu disalin
   Writer. Kasus nyata: bullet seller "✓ Mengobati vertigo dan sakit kepala"
   bertahan tiga iterasi sebagai "fakta yang boleh dipakai" dari Planner,
   sekalipun bahan Writer sudah bersih — karena Planner membaca sumber utuh.
   Reviewer TIDAK memakai ini: dia justru harus melihat klaim penjual untuk
   menguji R-03 (halal) dan R-04 (BPOM/SNI/original). */
function rbWriterSource(item) {
  const tests = rbRules()
    .filter((r) => r.kind === 'regex')      // selalu dilarang, sekalipun penjual menyebutnya
    .reduce((a, r) => a.concat(r.patterns || []), []);
  return String(sourceText(item))
    .split('\n')
    .filter((l) => !tests.some((p) => new RegExp(p, 'i').test(l)))
    .join('\n');
}

/* dipakai Planner untuk menyaring fakta yang dia usulkan sendiri */
function rbClaimHit(text) {
  const t = String(text || '');
  if (!t) return false;
  return rbRules()
    .filter((r) => r.kind === 'regex')
    .some((r) => (r.patterns || []).some((p) => new RegExp(p, 'i').test(t)));
}

/* ---------- pembaca angka ----------
   Konvensi Indonesia: koma = desimal, titik = pemisah ribuan.
   "64,0RB" dan "Rp64.000" harus dianggap angka yang sama. */
function rbNum(s) {
  let t = String(s).trim();
  if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/\./g, '');
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

const RB_UNITS = ['rb', 'ribu', 'juta', 'k', 'ml', 'liter', 'l', 'gram', 'gr', 'kg',
  'cm', 'mm', 'inci', 'inch', 'watt', 'mah', 'jam', 'tahun', 'bulan', 'hari'];

function rbFacts(text) {
  const t = String(text || '').toLowerCase();
  const pair = new Set(), bare = new Set(), units = new Set();
  const re = /(\d[\d.,]*)\s*(rb|ribu|juta|k|ml|liter|l|gram|gr|kg|cm|mm|inci|inch|watt|mah|jam|tahun|bulan|hari)?\b/g;
  let m;
  while ((m = re.exec(t))) {
    let v = rbNum(m[1]);
    if (v == null) continue;
    bare.add(Math.round(v));
    let u = m[2] || '';
    if (u === 'k' || u === 'ribu') u = 'rb';
    if (u === 'juta') { v *= 1e6; u = 'rp'; }
    else if (u === 'rb') { v *= 1e3; u = 'rp'; }
    if (u) units.add(u);
    pair.add((u || '?') + ':' + Math.round(v));
  }
  const re2 = /rp\s*(\d[\d.,]*)/g;
  while ((m = re2.exec(t))) {
    const v = rbNum(m[1]);
    if (v != null) { pair.add('rp:' + Math.round(v)); bare.add(Math.round(v)); units.add('rp'); }
  }
  return { pair, bare, units };
}

/* angka di draf yang tidak punya dukungan di sumber */
function unsupportedNumbers(draftText, src) {
  const d = rbFacts(draftText);
  const s = rbFacts(src);
  const out = [];
  d.pair.forEach((k) => {
    if (k.charAt(0) === '?') return;                       // angka tanpa satuan: tidak dinilai
    if (s.pair.has(k)) return;
    const [u, v] = k.split(':');
    /* toleransi: nilai ada di sumber DAN satuannya dikenal sumber
       (menangani rentang seperti "8-12 jam") */
    if (s.bare.has(Number(v)) && s.units.has(u)) return;
    out.push(u === 'rp' ? 'Rp' + Number(v).toLocaleString('id-ID') : v + ' ' + u);
  });
  return out;
}

/* ---------- lapis 1: mesin aturan deterministik ---------- */
function rbViolation(rule, evidence, extra) {
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    basis: rule.basis,
    evidence: String(evidence || '').slice(0, 120),
    fix: rule.fix,
    source: extra || 'aturan'
  };
}

/* negasi di depan kata membuat klaim tidak dihitung ("bukan obat", "tanpa obat") */
function rbNegated(text, at) {
  const before = text.slice(Math.max(0, at - 16), at).toLowerCase();
  return /\b(bukan|tanpa|tidak|belum|nggak|gak)\s+$/.test(before);
}

function rbScan(pf, item, draft) {
  const out = [];
  const text = draftTextOf(pf, draft);
  const lower = text.toLowerCase();
  const src = sourceText(item);
  const srcLower = src.toLowerCase();

  rbRulesFor(pf).forEach((rule) => {
    if (rule.kind === 'regex') {
      (rule.patterns || []).forEach((p) => {
        const re = new RegExp(p, 'gi');
        let m;
        while ((m = re.exec(text))) {
          if (rule.negatable && rbNegated(text, m.index)) continue;
          out.push(rbViolation(rule, m[0]));
          break;
        }
      });
    } else if (rule.kind === 'gated') {
      /* Klaim hanya boleh kalau SUMBER menyebut hal yang sama persis.
         Sebelumnya gerbangnya satu regex besar untuk semua pola — cukup satu
         kata ("original") di sumber, dan "BPOM" ikut lolos. Sekarang yang
         diperiksa adalah teks yang benar-benar diklaim. */
      (rule.patterns || []).forEach((p) => {
        const re = new RegExp(p, 'gi');
        let m;
        while ((m = re.exec(text))) {
          if (srcLower.indexOf(m[0].toLowerCase()) >= 0) continue;
          out.push(rbViolation(rule, m[0], 'sumber tidak menyebutkan'));
          break;
        }
      });
    } else if (rule.kind === 'tone') {
      (rule.phrases || []).forEach((ph) => {
        const re = new RegExp('\\b' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(text)) out.push(rbViolation(rule, ph));
      });
      const emo = (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || []).length;
      if (rule.maxEmoji && emo > rule.maxEmoji) out.push(rbViolation(rule, emo + ' emoji'));
      const letters = text.replace(/[^A-Za-z]/g, '');
      const caps = text.replace(/[^A-Z]/g, '');
      if (rule.maxCapsRatio && letters.length > 40 && caps.length / letters.length > rule.maxCapsRatio) {
        out.push(rbViolation(rule, Math.round((caps.length / letters.length) * 100) + '% huruf kapital'));
      }
    } else if (rule.kind === 'numeric') {
      unsupportedNumbers(text, src).forEach((n) => out.push(rbViolation(rule, n, 'angka tidak ada di sumber')));
    } else if (rule.kind === 'format') {
      /* validateContent membaca plat(item,pf) — yaitu draf yang SUDAH tersimpan,
         bukan draf yang sedang dinilai. Saat pipeline berjalan, draf baru belum
         ditugaskan, jadi tanpa penukaran sementara ini aturan format akan
         memeriksa konten lama dan meloloskan draf yang sebenarnya melanggar.
         Nilai asli dikembalikan lewat finally supaya tidak ada efek samping. */
      const p = plat(item, pf);
      const keys = pf === 'threads' ? ['posts'] : ['hook', 'scenes', 'caption'];
      const saved = {};
      keys.forEach((k) => { saved[k] = p[k]; });
      let v = { ok: true, reasons: [] };
      try {
        keys.forEach((k) => { p[k] = draft[k]; });
        v = validateContent(item, pf);
      } finally {
        keys.forEach((k) => { p[k] = saved[k]; });
      }
      /* validateContent juga memeriksa frasa terlarang dan emoji. Itu wilayah
         R-06 yang cuma peringatan — kalau ikut masuk R-07, hal yang seharusnya
         sekadar dicatat berubah jadi penghalang. Disaring di sini supaya satu
         pelanggaran tidak dihitung dua kali dengan bobot berbeda. */
      (v.reasons || [])
        .filter((r) => !/^frasa terlarang|^emoji lebih dari/.test(r))
        .forEach((r) => out.push(rbViolation(rule, r)));
    } else if (rule.kind === 'disclosure') {
      const ok = (rule.patterns || []).some((p) => new RegExp(p, 'i').test(text));
      if (!ok) out.push(rbViolation(rule, 'tidak ada penanda afiliasi'));
    }
  });

  /* satu aturan boleh muncul beberapa kali kalau buktinya beda ("24 jam" dan
     "45 liter" adalah dua karangan angka, bukan satu). Batas 3 bukti per
     aturan supaya transkrip tidak dibanjiri; sisanya tidak dirinci. */
  const seen = new Set();
  const count = new Map();
  const kept = [];
  out.forEach((v) => {
    const k = v.ruleId + '|' + v.evidence;
    if (seen.has(k)) return;
    const n = count.get(v.ruleId) || 0;
    if (n >= 3) return;
    seen.add(k);
    count.set(v.ruleId, n + 1);
    kept.push(v);
  });
  return kept;
}

/* teks gabungan satu draf — dipakai mesin aturan dan transkrip */
function draftTextOf(pf, draft) {
  if (!draft) return '';
  if (pf === 'threads') return (draft.posts || []).join('\n\n');
  return [
    draft.hook,
    (draft.scenes || []).join(' '),
    draft.caption,
    (draft.hashtags || []).map((h) => '#' + h).join(' ')
  ].filter(Boolean).join('\n');
}

/* ---------- lapis 2: Reviewer LLM ----------
   Menangkap pelanggaran yang tidak bisa ditangkap pola: klaim tersirat,
   nada yang menyamar, angka yang dibulatkan. Tidak berwenang menambah
   aturan baru — ID yang tidak ada di rulebook dibuang. */
async function rbReviewerLLM(pf, item, draft) {
  const cfg = aiCfg();
  const rules = rbRulesFor(pf).map((r) =>
    `- ${r.id} (${r.severity}) ${r.title}\n  ${r.explain}`
  ).join('\n');

  const sys = [
    'Kamu REVIEWER konten afiliasi. Tugasmu menilai, bukan menulis ulang.',
    'Kamu hanya boleh menilai berdasarkan aturan yang diberikan. Jangan mengarang aturan baru.',
    'Kutipan bukti harus memuat sendiri kata, frasa, atau angka yang melanggar aturan itu. Kalimat yang cuma mirip, atau yang justru menyangkal klaim, bukan bukti.',
    'Jawab HANYA JSON, tanpa penjelasan di luar JSON.',
    '',
    'Skema:',
    '{"verdict":"lulus"|"tolak","violations":[{"ruleId":"R-01","evidence":"kutipan persis dari draf","why":"satu kalimat"}]}',
    '',
    'Aturan yang berlaku:',
    rules
  ].join('\n');

  const usr = [
    'PRODUCT SHEET (satu-satunya sumber fakta yang boleh dipakai):',
    sourceText(item).slice(0, 3000),
    '',
    'DRAF YANG DINILAI:',
    draftTextOf(pf, draft).slice(0, 4000),
    '',
    'Nilai draf di atas. Kalau tidak ada pelanggaran, verdict "lulus" dan violations kosong.'
  ].join('\n');

  const raw = await callLLM(cfg, sys, usr, 90000);
  const o = parseJSONLoose(raw);
  const valid = new Set(rbRulesFor(pf).map((r) => r.id));
  const list = (Array.isArray(o.violations) ? o.violations : []).map((v) => {
    const rule = rbRule(v.ruleId);
    if (!rule || !valid.has(v.ruleId)) return null;          // ID karangan dibuang
    return rbViolation(rule, v.evidence || '', (v.why || 'dinilai LLM'));
  }).filter(Boolean);
  return { verdict: list.length ? 'tolak' : 'lulus', violations: list };
}

/* ---------- Planner ---------- */
function rbFallbackBrief(item) {
  const d = (item && item.detail) || {};
  return {
    angle: item.plot || 'p1',
    fakta: [item.name, item.priceText ? 'harga ' + item.priceText : '', d.specs && d.specs !== 'Lihat deskripsi' ? d.specs : '']
      .filter(Boolean),
    dilarang: ['klaim sembuh/mengobati', 'klaim halal tanpa sertifikat', 'BPOM/SNI/original tanpa dasar', 'janji hasil'],
    rencana: ['buka dengan masalah nyata pemakai', 'jelaskan satu fakta spesifik dari sumber', 'tutup dengan pengungkapan afiliasi']
  };
}

async function rbPlanner(pf, item) {
  const cfg = aiCfg();
  const sys = [
    'Kamu PLANNER konten afiliasi. Tugasmu menyusun brief, bukan menulis konten.',
    'Brief harus hanya memakai fakta dari product sheet yang diberikan.',
    'Jawab HANYA JSON:',
    '{"angle":"sudut pesan satu kalimat","fakta":["fakta konkret dari sumber"],"dilarang":["klaim yang tidak boleh dipakai"],"rencana":["urutan bagian"]}'
  ].join('\n');
  const usr = [
    'PLATFORM: ' + (pf === 'threads' ? 'Threads (utas teks 3–5 post)' : 'TikTok (naskah video pendek)'),
    '',
    'PRODUCT SHEET:',
    rbWriterSource(item).slice(0, 3000)
  ].join('\n');
  const raw = await callLLM(cfg, sys, usr, 90000);
  const o = parseJSONLoose(raw);
  /* fakta yang mengandung klaim terlarang dibuang di sini, sebelum sempat
     menjadi izin bagi Writer */
  const fakta = (Array.isArray(o.fakta) ? o.fakta : []).map(String).filter((f) => !rbClaimHit(f)).slice(0, 6);
  return {
    angle: String(o.angle || '').slice(0, 160),
    fakta,
    dilarang: (Array.isArray(o.dilarang) ? o.dilarang : []).map(String).slice(0, 6),
    rencana: (Array.isArray(o.rencana) ? o.rencana : []).map(String).slice(0, 6)
  };
}

function rbBriefText(brief) {
  if (!brief) return '';
  return [
    '',
    '=== BRIEF DARI PLANNER (patuhi, jangan menambah fakta di luar ini) ===',
    'Sudut: ' + brief.angle,
    'Fakta yang boleh dipakai: ' + brief.fakta.join(' · '),
    'Klaim yang dilarang: ' + brief.dilarang.join(' · '),
    'Urutan: ' + brief.rencana.join(' → ')
  ].join('\n');
}

/* ---------- catatan transkrip ---------- */
function rbTraceAdd(trace, role, text, extra) {
  const row = { role, at: Date.now(), text: String(text || '').slice(0, 900) };
  if (extra) Object.assign(row, extra);
  trace.push(row);
  return row;
}

/* Kata persis yang membuat aturan berpola tersentuh. Bukti dari Reviewer
   kadang berupa satu kalimat panjang, dan Writer cenderung memperbaiki
   kalimatnya sambil tetap memakai kata terlarangnya ("obat" → "obat herbal").
   Jadi yang dikirim balik bukan hanya kalimatnya, tapi tokennya. */
function rbOffendingTokens(violations) {
  const out = [];
  violations.forEach((v) => {
    const rule = rbRule(v.ruleId);
    if (!rule || !rule.patterns) return;
    const ev = String(v.evidence || '');
    rule.patterns.forEach((p) => {
      const m = new RegExp(p, 'i').exec(ev);
      if (!m) return;
      const t = String(m[0]).trim();
      if (t && t.length <= 40 && out.indexOf(t) < 0) out.push(t);
    });
  });
  return out;
}

function rbReviseNote(violations) {
  const lines = violations.map((v) =>
    `- [${v.ruleId}] ${v.title}: "${v.evidence}" → ${v.fix}`
  );
  const tokens = rbOffendingTokens(violations);
  const parts = [
    '',
    '',
    '=== REVISI WAJIB (draf sebelumnya DITOLAK Reviewer) ===',
    ...lines
  ];
  if (tokens.length) {
    parts.push('', `Kata/frasa berikut harus HILANG dari seluruh draf, bukan diganti sinonim: ${tokens.map((t) => `"${t}"`).join(', ')}. Tulis ulang kalimatnya dengan menyebut merek atau pengalaman pemakaian.`);
  }
  parts.push('', 'Perbaiki tepat pada bagian yang disebut. Jangan menambah fakta baru, jangan menambah scene/post, jangan mengubah bagian yang tidak disebut.');
  return parts.join('\n');
}

/* Lapis 2 (LLM) boleh menambah aturan yang lolos dari pola, tapi buktinya
   harus lulus uji yang tertulis di aturan itu sendiri. Kalau tidak lulus,
   bukti itu BUKAN dibuang diam-diam — ia turun jadi catatan untuk manusia.

   Kenapa begini. Kasus nyata: draf obat vertigo ditolak tiga iterasi lalu
   dieskalasi. Mesin aturan deterministik sebenarnya sudah bersih di iterasi
   ketiga; yang menahan hanya dua temuan lapis 2 — "produk ini bisa dibilang
   herbal dan aman" (R-02, tidak memuat satu pun kata penyakit atau kata
   menyembuhkan) dan "hasilnya bisa bervariasi" (R-05, itu justru kalimat
   penyangkalan, bukan janji). Reviewer LLM berganti pikiran tiap iterasi:
   memperbaiki satu temuan hanya memunculkan temuan baru, dan pipeline tidak
   pernah bisa konvergen.

   Aturan yang tidak bisa dibuktikan terhadap teksnya sendiri tidak boleh
   memveto draf. Yang memblokir hanya temuan yang lolos uji:
   - numeric : kutipan memuat angka yang tidak ada di sumber
   - regex   : kutipan cocok dengan salah satu pola aturan (dan tidak dinegasi)
   - gated   : kutipan cocok dengan pola, dan yang diklaim tidak ada di sumber
   kind lain (tone/format/disclosure) sudah diperiksa tuntas oleh lapis 1. */
function rbVerifiable(pf, item, v, draftText) {
  if (!v || !v.ruleId) return false;
  const ev = String(v.evidence == null ? '' : v.evidence).trim();
  if (!ev) return false;
  const rule = rbRulesFor(pf).find((r) => r.id === v.ruleId);
  if (!rule) return false;

  /* Uji pertama dan paling penting: kutipannya harus benar-benar ada di draf.
     Tanpa ini, reviewer bisa "mengutip" kalimat yang tidak pernah ditulis —
     dan selama kalimat karangan itu cocok dengan pola aturan, ia lolos semua
     uji berikutnya lalu memblokir draf yang sebenarnya bersih. Ini yang
     terjadi pada naskah TikTok obat vertigo: tiga iterasi ditolak dengan bukti
     "Mengobati vertigo dan sakit kepala" yang tidak ada di satu pun draf. */
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase();
  const dNorm = norm(draftText);
  const probe = norm(ev).slice(0, 40);
  if (probe && dNorm.indexOf(probe) < 0) return false;

  if (rule.kind === 'numeric') {
    const src = sourceText(item).toLowerCase();
    const nums = ev.match(/\d+(?:[.,]\d+)?/g) || [];
    return nums.some((n) => src.indexOf(n.toLowerCase()) < 0);
  }

  if (rule.kind === 'regex' || rule.kind === 'gated') {
    const src = sourceText(item).toLowerCase();
    return (rule.patterns || []).some((p) => {
      const m = new RegExp(p, 'i').exec(ev);
      if (!m) return false;
      if (rule.kind === 'regex' && rule.negatable && rbNegated(ev, m.index)) return false;
      if (rule.kind === 'gated' && src.indexOf(m[0].toLowerCase()) >= 0) return false;
      return true;
    });
  }

  return false;
}

/* ---------- pipeline ----------
   `onStep(nama, fase, info)` dipanggil setiap kali satu agent mulai dan selesai.
   Ini satu-satunya sumber untuk indikator "sedang bekerja" di UI — bukan timer,
   bukan animasi. Kalau sebuah langkah tidak benar-benar berjalan, indikatornya
   juga tidak menyala. */
async function runAgentPipeline(pf, item, onStep) {
  const cfg = aiCfg();
  if (!aiReady()) throw new Error('LLM belum dikonfigurasi');

  const emit = (step, phase, info) => {
    if (typeof onStep !== 'function') return;
    try { onStep(step, phase, info || {}); } catch (e) { /* UI tidak boleh menggagalkan pipeline */ }
  };
  const steps = { planner: 0, writer: 0, reviewer: 0 };

  const trace = [];
  let brief = null;

  /* --- Planner --- */
  emit('planner', 'start', { iter: 0 });
  let t0 = Date.now();
  try {
    brief = await rbPlanner(pf, item);
    const ms = Date.now() - t0;
    steps.planner = ms;
    rbTraceAdd(trace, 'planner', `Sudut: ${brief.angle}\nFakta: ${brief.fakta.join(' · ')}\nDilarang: ${brief.dilarang.join(' · ')}`, { iter: 0, ms });
    emit('planner', 'done', { iter: 0, ms });
  } catch (e) {
    const ms = Date.now() - t0;
    steps.planner = ms;
    brief = rbFallbackBrief(item);
    rbTraceAdd(trace, 'planner', `Planner gagal (${e.message || e}). Brief diturunkan dari product sheet tanpa LLM.`, { iter: 0, degraded: true, ms });
    emit('planner', 'done', { iter: 0, ms, degraded: true });
  }

  const briefText = rbBriefText(brief);
  let draft = null, violations = [], iterations = 0, revise = '';

  for (let it = 1; it <= AGENT_MAX_ITER; it++) {
    iterations = it;

    /* --- Writer --- */
    emit('writer', 'start', { iter: it });
    t0 = Date.now();
    if (pf === 'threads') draft = { posts: await llmThreads(item, { brief: briefText, revise }) };
    else draft = await llmTiktok(item, { brief: briefText, revise });
    const wms = Date.now() - t0;
    steps.writer += wms;
    rbTraceAdd(trace, 'writer', draftTextOf(pf, draft), { iter: it, ms: wms });
    emit('writer', 'done', { iter: it, ms: wms });

    /* --- Reviewer --- */
    emit('reviewer', 'start', { iter: it });
    t0 = Date.now();

    /* lapis 1: mesin aturan deterministik */
    const scan = rbScan(pf, item, draft);

    /* lapis 2: LLM, menangkap yang lolos dari pola */
    let llmList = [], degraded = false;
    try {
      const r = await rbReviewerLLM(pf, item, draft);
      llmList = r.violations;
    } catch (e) {
      degraded = true;
      rbTraceAdd(trace, 'system', `Reviewer LLM tidak tersedia (${e.message || e}). Penilaian hanya dari mesin aturan deterministik.`, { iter: it, degraded: true });
    }

    /* gabung: kalau mesin aturan sudah menangkap sebuah aturan, bukti dari
       mesin aturan yang dipakai — LLM hanya menambah aturan yang lolos dari pola.
       Tambahan dari LLM diuji dulu terhadap definisi aturannya. Yang lulus
       boleh memblokir; yang tidak lulus turun jadi catatan, dan penurunannya
       dicatat di trace supaya bisa diperiksa manusia. */
    const scanIds = new Set(scan.map((v) => v.ruleId));
    const llmExtra = [];
    const llmNotes = [];
    llmList.forEach((v) => {
      if (scanIds.has(v.ruleId)) return;
      if (rbVerifiable(pf, item, v, draftTextOf(pf, draft))) llmExtra.push(v);
      else llmNotes.push({ ...v, severity: 'warn', source: 'catatan lapis 2' });
    });
    if (llmNotes.length) {
      rbTraceAdd(trace, 'system',
        `Reviewer LLM menyebut ${llmNotes.length} hal yang tidak lolos uji definisi aturannya — dicatat, tidak membatalkan draf: `
        + llmNotes.map((v) => `${v.ruleId} "${v.evidence}"`).join(' · '),
        { iter: it, notes: llmNotes.map((v) => ({ ruleId: v.ruleId, evidence: v.evidence })) });
    }
    violations = scan.concat(llmExtra, llmNotes);

    const blocked = violations.filter((v) => v.severity === 'block');
    const warned = violations.filter((v) => v.severity !== 'block');
    const ruleIds = [...new Set(blocked.map((v) => v.ruleId))];
    const rms = Date.now() - t0;
    steps.reviewer += rms;

    rbTraceAdd(trace, 'reviewer',
      blocked.length
        ? `DITOLAK — ${ruleIds.length} aturan dilanggar (${blocked.length} bukti): ` + blocked.map((v) => `${v.ruleId} "${v.evidence}"`).join(' · ')
        : `LULUS. ${warned.length ? 'Catatan: ' + warned.map((v) => v.ruleId + ' ' + v.evidence).join(' · ') : 'Tidak ada pelanggaran.'}`,
      { iter: it, verdict: blocked.length ? 'tolak' : 'lulus', violations: violations.map((v) => ({ ruleId: v.ruleId, evidence: v.evidence, severity: v.severity })), degraded, ms: rms });

    emit('reviewer', 'done', { iter: it, ms: rms, verdict: blocked.length ? 'tolak' : 'lulus' });

    if (!blocked.length) {
      return {
        draft, trace, iterations, steps,
        review: {
          state: 'pass', verdict: 'lulus', iterations, steps,
          violations, blocked: [], warned,
          model: cfg.provider + '/' + cfg.model, at: Date.now(),
          degraded: degraded || false
        }
      };
    }

    if (it < AGENT_MAX_ITER) {
      revise = rbReviseNote(blocked);
      rbTraceAdd(trace, 'system', `Draf dikembalikan ke Writer dengan ${blocked.length} perbaikan wajib (iterasi ${it}/${AGENT_MAX_ITER}).`, { iter: it });
    }
  }

  /* habis 3 iterasi: berhenti, jangan berputar */
  rbTraceAdd(trace, 'system',
    `Batas ${AGENT_MAX_ITER} iterasi tercapai dan masih ada pelanggaran. Pipeline BERHENTI — keputusan diserahkan ke manusia.`,
    { iter: iterations, escalated: true });

  return {
    draft, trace, iterations, steps,
    review: {
      state: 'escalated', verdict: 'tolak', iterations, steps,
      violations,
      blocked: violations.filter((v) => v.severity === 'block'),
      warned: violations.filter((v) => v.severity !== 'block'),
      model: cfg.provider + '/' + cfg.model, at: Date.now()
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runAgentPipeline, rbScan, sourceText, unsupportedNumbers, draftTextOf, AGENT_MAX_ITER };
}
