# Sampul — spesifikasi 380×216, 3 varian, prompt & cara render

## Spesifikasi resmi

> Cover Image — A 16:9 cover image for your project, used for the online showcase.
> Recommended size: **380 × 216 px**

Yang perlu dipahami dari angka itu:

- **380×216 bukan 16:9 pas.** 380/216 = **1,759**, sedangkan 16:9 = 1,778. Selisihnya ~2 px pada tinggi. Panduan menyebut "16:9" sebagai bentuk umum, lalu memberi angka konkret 380×216 — **angka konkret yang dipakai**, karena itu yang dirender oleh halaman showcase.
- **1140×648 adalah 3× tepat dari 380×216.** Jadi kanvas desain dibuat 1140×648, lalu diskalakan 1/3 → keluar 380×216 tanpa sisa piksel. Ini satu-satunya ukuran besar yang bisa dipercaya sebagai sumber.
- Kalau mengunggah yang lebih besar, pakai **1140×648** (3×), bukan 1920×1080 — 1920×1080 rasionya 1,778 dan akan dipotong ~2% oleh wadah 1,759.

## Dua jenis berkas (jangan tertukar)

| Keperluan | Berkas | Ukuran | Layout |
|---|---|---|---|
| **Pengumpulan (showcase)** | `sampul-v{1,2,3}-380x216.png` | 380×216 | judul + 1 tagline saja |
| Pengumpulan, versi tajam | `sampul-v{1,2,3}-1140x648.png` | 1140×648 (3×) | sama, dirender lebih besar |
| Presentasi / slide video | `sampul-v{1,2,3}-1920x1080.png` | 1920×1080 | layout penuh (chip, footer) |

**Kenapa layout-nya beda, bukan cuma dikecilkan:** pada 380 px lebar, teks 29 px di kanvas 1920 menjadi **5,7 px** — tidak terbaca, cuma bercak. Karena itu versi 380 membuang chip Planner/Writer/Reviewer, footer, dan angka pengujian, lalu menaikkan judul ke 86 px (→ 28,7 px pada 380) dan menyisakan satu tagline 23 px (→ 7,7 px). Yang tidak terbaca dibuang, bukan diperkecil.

## Varian

| Varian | Sifat |
|---|---|
| **V1 · Gelap sinematik** | identitas hackathon tampil (`Tantangan C · Agen Kreator`), tema gelap |
| **V2 · Isometrik** | identitas hackathon tampil, tema terang, paling "menjelaskan alur" |
| **V3 · Tanpa identitas hackathon** | sampul produk: tanpa Tencent, tanpa Tantangan C, kicker `Alat konten afiliasi mandiri` |

Ketiganya memakai judul, tagline, dan tata letak yang sama — hanya latar dan teks kecil yang berbeda, supaya bisa dibandingkan tanpa gangguan.

Ilustrasi mentah (tanpa teks): `sampul-latar-ai-gelap.png` (V1), `sampul-latar-ai-iso.png` (V2), `sampul-latar-ai.png` (V3).

## Sumber tipografi

- **`sampul-380.html`** — kanvas 1140×648, untuk berkas pengumpulan. `?v=1|2|3`, `?w=380` untuk versi kecil.
- **`sampul-varian.html`** — kanvas 1920×1080, untuk presentasi. `?v=1|2|3`, `?w=1140` untuk versi kecil.

Dua berkas karena layout-nya memang berbeda, bukan karena malas menggabungkan.

## Kenapa teks tidak dibuat oleh model gambar

Model gambar menghasilkan huruf yang hampir selalu rusak — satu huruf salah sudah cukup membuat sampul tidak layak dipakai. Jadi: **model gambar hanya membuat ilustrasi latar tanpa satu huruf pun**, tipografi ditempel HTML + Chrome headless.

## Prompt yang dipakai

**V1 — gelap sinematik** (`sampul-latar-ai-gelap.png`)

```
Editorial tech illustration, dark navy background (#0e1420), three simplified
humanoid figures lit from the side in indigo #4f7cff, coral #ff6b4a, and amber
#e0a03a, a floating document panel glowing faintly between them, one figure
raising a red approval stamp, a human hand entering from the right with a thin
green checkmark arc, volumetric haze, soft rim light, premium SaaS key visual,
composition weighted right with empty space on the left third, no text,
no letters, no words, no numbers, no logos, no watermark.
```

**V2 — isometrik** (`sampul-latar-ai-iso.png`)

```
Isometric flat vector illustration on a light gray background (#f5f6f8), three
stacked work surfaces at different heights connected by thin arrows, accents in
indigo blue #2563eb, coral #ee4d2d and amber #a8630a, paper documents and a small
red rubber stamp on the top surface, a human hand with a thin green checkmark at
the output stage, clean geometric shapes, subtle soft shadows, muted palette,
generous empty space on the left third, premium SaaS explainer aesthetic,
no text, no letters, no words, no numbers, no logos, no watermark.
```

**V3 — ilustrasi terang** (`sampul-latar-ai.png`)

```
Wide editorial illustration, flat geometric vector style, for a premium software
product cover. Light warm-gray background (#f5f6f8). Composition weighted to the
right two-thirds, with generous empty space on the left third. Three abstract
simplified humanoid figures stand in a row facing a large floating rectangular
card: the first figure is indigo blue (#2563eb) and gestures at an empty outline
on the card, the second is coral orange (#ee4d2d) and draws short gray placeholder
lines onto the card, the third is amber (#a8630a) and lifts a small red circular
stamp above the card. A thin green (#0f8a4f) checkmark arc curves from the card
toward a human hand entering from the right edge. Soft long shadows, thin hairline
details, muted palette, lots of negative space, clean high-end SaaS landing page
aesthetic, calm and trustworthy. No text, no letters, no words, no numbers, no
logos, no watermark.
```

Parameter semua: `size 1536x1024`, `quality high`.

Tiga hal yang wajib ada di prompt mana pun:

1. **"empty space on the left third"** — tanpa ini model mengisi seluruh kanvas dan judul tidak punya tempat.
2. **"No text, no letters, no words, no numbers"** — disebut empat kali dengan sengaja; sekali saja tidak cukup.
3. **Hex warna per figur** — Planner biru, Writer koral, Reviewer amber, centang hijau. Ini yang membuat gambar cocok dengan chip di UI.

## Cara render ulang

Butuh Chrome (tidak perlu npm/playwright).

**Berkas pengumpulan (380×216 dan 3×-nya):**

```bash
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
cd /c/workspace_workbuddy/afiliasi

for v in 1 2 3; do
  # 380x216 — ukuran yang diminta panduan
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=380,216 \
    --screenshot="C:\workspace_workbuddy\afiliasi\hackathon\sampul-v${v}-380x216.png" \
    "file:///C:/workspace_workbuddy/afiliasi/hackathon/sampul-380.html?v=${v}&w=380"

  # 1140x648 — 3x tepat
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1140,648 \
    --screenshot="C:\workspace_workbuddy\afiliasi\hackathon\sampul-v${v}-1140x648.png" \
    "file:///C:/workspace_workbuddy/afiliasi/hackathon/sampul-380.html?v=${v}"
done
```

**Versi presentasi (1920×1080):**

```bash
for v in 1 2 3; do
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1920,1080 \
    --screenshot="C:\workspace_workbuddy\afiliasi\hackathon\sampul-v${v}-1920x1080.png" \
    "file:///C:/workspace_workbuddy/afiliasi/hackathon/sampul-varian.html?v=${v}"
done
```

## Jebakan yang sudah kena

- **Watermark model di pojok kanan bawah.** Ilustrasi dirender lebih besar dari kanvas lalu digeser, sehingga watermark jatuh di luar bingkai. Di `sampul-380.html`: lebar 1100 (tinggi 733) dengan `top:0` — pada tinggi 733 watermark ada di y≈689, di bawah kanvas 648. Di `sampul-varian.html`: lebar 1920, `top:-120`. Kalau mengganti latar, periksa pojok kanan bawah dulu.
- **Lapisan pemutih terlalu tebal.** Versi pertama memakai `rgba(245,246,248,.42)` dan figur Planner (biru) hilang sama sekali. Sekarang `.wash` hanya `.08`–`.10`.
- **Teks menabrak ilustrasi.** Bukan soal ukuran font, tapi lebar kolom. Di kanvas 1140, `bgLeft:200` dan kolom teks 500 px; di kanvas 1920, `bgLeft:40` dan `subMax:520–560`.
- **Mengecilkan layout 1920 ke 380 tidak bisa.** Hasilnya teks 5 px. Dua layout terpisah itu keputusan, bukan kelalaian.
