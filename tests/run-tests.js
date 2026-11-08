/* ============================================================
   RUNNER PENGUJIAN — Tantangan C
   ------------------------------------------------------------
   Menjalankan 20 test case terhadap Reviewer sungguhan di browser
   (bukan tiruan), lalu membandingkan putusannya dengan harapan.

   Jalankan: node tests/run-tests.js
   Hasil  : tests/results.json + tests/hasil-pengujian.html
   ============================================================ */
const fs = require('fs');
const path = require('path');

/* Dua paket bisa dipakai: "playwright" (lengkap) atau "playwright-core"
   (tanpa unduhan browser). Yang kedua cukup karena skrip ini memakai Chrome
   yang sudah terpasang lewat channel: 'chrome'. */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('playwright-core')); }

const ROOT = path.join(__dirname, '..');
const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'testcases.json'), 'utf8'));

/* pengisi netral: menaikkan panjang post tanpa menambah fakta, angka, atau klaim */
const FILLER = ' Kalimat ini hanya pengisi supaya panjang post masuk batas platform, tidak menambah informasi baru.';

function padTo(s, n) {
  let t = String(s);
  while (t.length < n) t += FILLER;
  return t.slice(0, Math.max(n, t.length));
}

function buildThreads(c, url) {
  const posts = (c.posts || []).map((p) => (c.short ? p : padTo(p, 300)));
  if (!c.short && !c.noLink) {
    posts.push(padTo(
      'Kalau mau lihat varian sama deskripsi tokonya (di situ biasanya ketahuan mana yang jujur, mana yang cuma jualan), ' +
      'ini link afiliasinya:\n' + url + '\nAku dapat komisi kalau kamu beli dari sini — harga kamu tetap sama.',
      300
    ));
  }
  return { posts };
}

function buildTiktok(c) {
  const v = c.video || {};
  return {
    hook: v.hook || '',
    scenes: v.scenes || [],
    caption: v.caption || '',
    hashtags: []
  };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.setDefaultTimeout(30000);

  /* 'networkidle' tidak pernah tercapai: aplikasi punya scheduler yang menulis
     state berkala, jadi jaringan tidak pernah benar-benar diam 500 ms. Yang
     sebenarnya dibutuhkan adalah aplikasi selesai render — dan itu dijamin
     oleh penantian .nav-item di bawah. */
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav-item');

  const cases = SUITE.cases.map((c) => ({
    id: c.id, name: c.name, platform: c.platform,
    expect: c.expect, note: c.note,
    injectSource: c.injectSource || '',
    draft: c.platform === 'threads'
      ? buildThreads(c, '__URL__')
      : buildTiktok(c)
  }));

  const results = await page.evaluate((list) => {
    /* Produk dipatok, bukan "yang pertama punya detail". Kasus uji ini ditulis
       terhadap satu product sheet tertentu; kalau produknya berganti, angka
       di draf uji (2 liter, 20 x 8 x 42 cm) tidak ada di sumber baru dan R-01
       menyala di semua kasus — hasil uji jadi bergantung urutan impor. */
    const base = S.items.find((i) => i.productId === '19595697771')
      || S.items.find((i) => !i.archived && i.detail);
    const url = base.affiliateUrl || 'https://s.shopee.co.id/contoh';
    return list.map((c) => {
      const item = JSON.parse(JSON.stringify(base));
      if (c.injectSource) {
        item.detail = item.detail || {};
        item.detail.raw_description = String(item.detail.raw_description || '') + ' ' + c.injectSource;
      }
      const draft = JSON.parse(JSON.stringify(c.draft).replace('__URL__', url));
      let violations = [];
      let err = '';
      try { violations = rbScan(c.platform, item, draft); } catch (e) { err = String(e.message || e); }
      const block = [...new Set(violations.filter((v) => v.severity === 'block').map((v) => v.ruleId))].sort();
      const warn = [...new Set(violations.filter((v) => v.severity !== 'block').map((v) => v.ruleId))].sort();
      const wantBlock = (c.expect.block || []).slice().sort();
      const wantWarn = (c.expect.warn || []).slice().sort();
      const ok = !err && JSON.stringify(block) === JSON.stringify(wantBlock)
        && JSON.stringify(warn) === JSON.stringify(wantWarn);
      return {
        id: c.id, name: c.name, platform: c.platform, note: c.note,
        expect: c.expect, got: { block, warn },
        evidence: violations.map((v) => `${v.ruleId} "${v.evidence}"`),
        pass: ok, err
      };
    });
  }, cases);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  results.forEach((r) => {
    const tag = r.pass ? 'LULUS' : 'GAGAL';
    const exp = `blok[${(r.expect.block || []).join(',') || '-'}] peringatan[${(r.expect.warn || []).join(',') || '-'}]`;
    const got = `blok[${r.got.block.join(',') || '-'}] peringatan[${r.got.warn.join(',') || '-'}]`;
    console.log(`${r.id} ${tag.padEnd(5)} ${r.name}`);
    if (!r.pass) console.log(`     harap ${exp} · dapat ${got}${r.err ? ' · ERROR ' + r.err : ''}`);
  });
  console.log(`\n${pass}/${results.length} lulus · ${fail} gagal`);
  if (errs.length) console.log('ERRORS:', JSON.stringify(errs));

  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({
    suite: SUITE.suite, product: SUITE.product,
    ranAt: new Date().toISOString(),
    total: results.length, pass, fail, results
  }, null, 2));

  /* laporan HTML: tabel yang bisa dibaca manusia dan dipotret */
  const rows = results.map((r) => `
    <tr class="${r.pass ? 'ok' : 'bad'}">
      <td class="id">${r.id}</td>
      <td>${r.name}<div class="note">${r.note || ''}</div></td>
      <td class="pf">${r.platform}</td>
      <td class="verdict">${r.pass ? 'LULUS' : 'GAGAL'}</td>
      <td class="mono">${(r.expect.block || []).join(', ') || '—'}</td>
      <td class="mono">${(r.expect.warn || []).join(', ') || '—'}</td>
      <td class="mono">${r.got.block.join(', ') || '—'}</td>
      <td class="mono">${r.got.warn.join(', ') || '—'}</td>
      <td class="ev">${r.evidence.slice(0, 3).join('<br>') || '—'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<title>Hasil Pengujian — Tantangan C</title>
<style>
body{font-family:"Inter","Segoe UI",system-ui,sans-serif;background:#f5f6f8;color:#14171f;margin:0;padding:28px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#6b7382;font-size:12.5px;margin-bottom:18px}
.sum{display:flex;gap:10px;margin-bottom:18px}
.pill{border-radius:10px;padding:10px 16px;font-weight:700;font-size:13px;border:1px solid #e6e8ee;background:#fff}
.pill b{font-size:19px;display:block}
.pill.ok{background:#e8f6ee;border-color:#c3e6d2;color:#0f8a4f}
.pill.bad{background:#fdecea;border-color:#f5c6c1;color:#c0392b}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;font-size:12px;
box-shadow:0 1px 2px rgba(20,23,31,.04),0 8px 24px -16px rgba(20,23,31,.18)}
th{background:#fafbfc;text-align:left;padding:9px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#6b7382;border-bottom:1px solid #e6e8ee}
td{padding:9px 10px;border-bottom:1px solid #eef0f4;vertical-align:top}
tr.ok .verdict{color:#0f8a4f;font-weight:700}
tr.bad{background:#fdf3f2}
tr.bad .verdict{color:#c0392b;font-weight:700}
.id{font-weight:700;white-space:nowrap}
.pf{color:#6b7382}
.note{color:#6b7382;font-size:11px;margin-top:2px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:nowrap}
.ev{font-size:11px;color:#3d4350;max-width:260px}
</style></head><body>
<h1>Hasil Pengujian — Tantangan C (Agen Kreator)</h1>
<div class="sub">${SUITE.product} · dijalankan ${new Date().toLocaleString('id-ID')} · Reviewer sungguhan (rbScan), bukan tiruan</div>
<div class="sum">
  <div class="pill ok">LULUS<b>${pass}</b></div>
  <div class="pill ${fail ? 'bad' : 'ok'}">GAGAL<b>${fail}</b></div>
  <div class="pill">TOTAL<b>${results.length}</b></div>
</div>
<table><thead><tr>
<th>ID</th><th>Kasus</th><th>Platform</th><th>Putusan</th>
<th>Harap blok</th><th>Harap peringatan</th><th>Dapat blok</th><th>Dapat peringatan</th><th>Bukti</th>
</tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

  fs.writeFileSync(path.join(__dirname, 'hasil-pengujian.html'), html);

  await page.goto('file:///' + path.join(__dirname, 'hasil-pengujian.html').replace(/\\/g, '/'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'screenshot-hasil.png'), fullPage: true });

  await browser.close();
  process.exit(fail ? 1 : 0);
})();
