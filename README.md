# Chatbot Backend (v2 — tanpa Google Drive)

Backend chatbot: FAQ dibaca dari file lokal `.docx` di server (bukan Google Drive lagi),
bisa diupdate kapan saja lewat halaman admin (`/admin.html`) yang dilindungi password,
tanpa perlu restart server.

## Isi folder ini (yang boleh & aman di-push ke GitHub)
```
server.js          → kode utama backend
package.json       → daftar dependency
public/admin.html  → halaman admin buat upload FAQ baru
data/*.docx        → file FAQ (boleh lebih dari satu, semuanya dibaca)
.env.example       → CONTOH isi .env (kosong, aman di-push)
.gitignore         → mencegah .env & node_modules ikut ke-push
```

**PENTING:** File `.env` yang asli (isi API key & password) **TIDAK** ada di folder ini
dan **TIDAK BOLEH** pernah di-push ke GitHub. Isi rahasia itu diisi langsung di Railway
(lihat langkah 4 di bawah).

---

## Langkah 1 — Push ke GitHub

Buka terminal di folder ini, lalu:

```bash
git init
git add .
git status
```

Cek hasil `git status` — pastikan **tidak ada** file `.env` di daftar (kalau ada, STOP,
jangan lanjut commit, cek `.gitignore` dulu).

Kalau aman:

```bash
git commit -m "chatbot backend v2 - tanpa google drive"
git branch -M main
git remote add origin <link-repo-github-kamu>
git push -u origin main
```

Kalau repo GitHub-nya belum ada, bikin dulu di github.com → "New repository" → jangan
centang "Add README" (biar gak konflik) → copy link repo-nya buat perintah `git remote` di atas.

---

## Langkah 2 — Buat project baru di Railway

1. Buka [railway.app](https://railway.app) → login pakai GitHub
2. "New Project" → "Deploy from GitHub repo" → pilih repo yang barusan di-push
3. Railway otomatis detect Node.js dan mulai build (akan gagal dulu, wajar, karena
   environment variable belum diisi — lanjut ke langkah 3)

## Langkah 3 — Generate domain

Tab **Settings → Networking → Generate Domain** — nanti dapat URL kayak
`namaproject.up.railway.app`

## Langkah 4 — Isi Environment Variables (INI YANG GANTIKAN .env)

Tab **Variables**, tambahkan satu-satu:

| Key | Value |
|---|---|
| `GEMINI_API_KEY` | API key dari [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| `ADMIN_PASSWORD` | Password bebas buat login halaman admin — pakai yang kuat |
| `ALLOWED_ORIGIN` | Domain website kamu yang boleh akses chatbot ini, misal `https://websitekamu.com` |
| `PORT` | `3000` |

Setelah disimpan, Railway otomatis redeploy.

## Langkah 5 — Tambah Volume (biar file upload gak hilang)

Tanpa ini, setiap Railway redeploy ulang (misal kamu push kode baru), file `faq.docx`
yang diupload lewat admin panel bakal balik ke versi awal (yang ikut ke-push di GitHub).

1. Tab **Settings → Volumes** → "New Volume"
2. Mount path: `/app/data`
3. Simpan

## Langkah 6 — Coba akses

- Chatbot API: `https://namaproject.up.railway.app/api/chat`
- Halaman admin: `https://namaproject.up.railway.app/admin.html`
  → login pakai `ADMIN_PASSWORD` yang tadi diisi di Variables
  → upload file `.docx` baru kapan saja, otomatis kepakai tanpa restart

---

## Kalau mau update FAQ nanti

Buka `namaproject.up.railway.app/admin.html` dari device mana saja → login → upload
satu atau **banyak file `.docx` sekaligus**. Semua file di folder `data/` digabung jadi
satu basis FAQ. Upload file dengan nama yang sama akan menimpa file lama; tombol **Hapus**
menghapus satu file. Gak perlu sentuh kode atau GitHub sama sekali.

Contoh pembagian file: `produk.docx`, `pengiriman.docx`, `kebijakan.docx`, dst.

## Format isi setiap file .docx

Setiap FAQ ditulis dengan format:
```
Q: Pertanyaan di sini?
A: Jawabannya di sini.

Q: Pertanyaan kedua?
A: Jawaban kedua.
```

---

## Filter berdasarkan file .docx

Setiap file `.docx` di folder `data/` bisa dipakai sebagai **filter/kategori**. Chatbot jadi hanya
mencari jawaban FAQ di file yang dipilih (lebih akurat & hemat token Gemini).

**1. Lihat filter yang tersedia**
```
GET /api/sources
→ { "sources": [ { "name": "produk.docx", "label": "produk", "entries": 12 }, ... ] }
```

**2. Kirim filter di `/api/chat`** (opsional — kalau tidak dikirim, semua file dipakai)
```json
{
  "messages": [{ "role": "user", "content": "Berapa lama pengiriman?" }],
  "sources": ["pengiriman", "kebijakan.docx"]
}
```
- Nama boleh dengan atau tanpa `.docx`, huruf besar/kecil tidak masalah.
- Nama yang tidak ada → HTTP 400 beserta daftar `available`.
- Kalau tidak ada FAQ yang cocok di file terpilih, pertanyaan tetap diteruskan ke Gemini (AI).
- Respons FAQ sekarang menyertakan `file` (asal jawaban), contoh: `{ "reply": "...", "source": "faq", "file": "pengiriman.docx" }`.

**3. Halaman admin** punya kotak pencarian untuk memfilter daftar file `.docx`.
