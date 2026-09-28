import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import multer from "multer";
import mammoth from "mammoth";
import { GoogleGenerativeAI } from "@google/generative-ai";

// =========================================================
// 1. KONFIGURASI DASAR
// =========================================================
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // password buat login halaman admin
const DATA_DIR = "./data";

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY belum diisi di file .env");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("❌ ADMIN_PASSWORD belum diisi di file .env — wajib diisi biar admin panel aman");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  systemInstruction: `Kamu adalah asisten customer service yang ramah, sopan, dan menjawab singkat dalam Bahasa Indonesia.
Jika kamu tidak yakin dengan jawaban, arahkan pelanggan untuk menghubungi admin langsung.
Jangan mengarang informasi seperti harga, kebijakan, atau nomor kontak yang tidak kamu ketahui pasti.`,
});

// =========================================================
// 2. BACA SEMUA FILE .docx DI FOLDER ./data
// =========================================================
let faqList = []; // [{ question, answer, source }]
let fileStats = {}; // { "nama.docx": jumlahEntri }

function daftarFileDocx() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"));
}

async function parseSatuFile(namaFile) {
  const result = await mammoth.extractRawText({ path: path.join(DATA_DIR, namaFile) });
  const blocks = result.value.split(/\n(?=Q:)/).filter((b) => b.trim().startsWith("Q:"));
  return blocks
    .map((block) => {
      const q = block.match(/Q:\s*(.+)/)?.[1]?.trim();
      const a = block.match(/A:\s*([\s\S]+)/)?.[1]?.trim();
      return { question: q, answer: a, source: namaFile };
    })
    .filter((item) => item.question && item.answer);
}

let sedangMuat = Promise.resolve();
function muatSemuaFaq() {
  // antre supaya reload yang bertumpuk tidak saling tabrakan
  sedangMuat = sedangMuat.then(async () => {
    const files = daftarFileDocx();
    if (files.length === 0) {
      console.warn("⚠️  Belum ada file .docx di ./data — upload lewat halaman admin dulu.");
      faqList = [];
      fileStats = {};
      return;
    }
    const gabungan = [];
    const stats = {};
    for (const f of files) {
      try {
        const items = await parseSatuFile(f);
        gabungan.push(...items);
        stats[f] = items.length;
      } catch (err) {
        console.error(`Gagal membaca ${f}:`, err.message);
        stats[f] = 0;
      }
    }
    faqList = gabungan;
    fileStats = stats;
    console.log(
      `✅ FAQ dimuat dari ${files.length} file (${faqList.length} entri) — ${new Date().toLocaleTimeString("id-ID")}`
    );
  });
  return sedangMuat;
}

// Pantau folder: file .docx apa pun yang ditambah/diganti/dihapus → otomatis dimuat ulang (debounce).
let debounceTimer;
fs.watch(DATA_DIR, (eventType, filename) => {
  if (filename && filename.toLowerCase().endsWith(".docx")) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      muatSemuaFaq().catch((err) => console.error("Gagal reload otomatis:", err.message));
    }, 500);
  }
});
const RELOAD_INTERVAL_MS = 5 * 60 * 1000;

// =========================================================
// 3. COCOKKAN PERTANYAAN USER KE FAQ (pakai Gemini sebagai "pemilih")
// =========================================================
async function cariFaqCocok(pertanyaanUser) {
  if (faqList.length === 0) return null;

  const daftarFaq = faqList.map((f, i) => `${i}. ${f.question}`).join("\n");
  const prompt = `Daftar FAQ:\n${daftarFaq}\n\nPertanyaan pelanggan: "${pertanyaanUser}"\n\nJika pertanyaan pelanggan cocok/mirip maksud dengan salah satu nomor di atas, balas HANYA dengan angka nomornya saja (contoh: "2"). Jika tidak ada yang cocok, balas persis: TIDAK ADA`;

  try {
    const result = await model.generateContent(prompt);
    const jawaban = result.response.text().trim();
    const index = parseInt(jawaban, 10);
    if (!isNaN(index) && faqList[index]) return faqList[index].answer;
    return null;
  } catch (err) {
    console.error("Gagal mencocokkan FAQ:", err.message);
    return null;
  }
}

// =========================================================
// 4. AUTH SEDERHANA UNTUK ADMIN (password lewat header)
// =========================================================
function cekAdmin(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password admin salah atau tidak dikirim" });
  }
  next();
}

// Simpan upload sementara sebelum divalidasi jadi .docx
const upload = multer({
  dest: "./tmp-uploads",
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // maks 10MB per file, 20 file sekali upload
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith(".docx");
    cb(ok ? null : new Error("Semua file harus berformat .docx"), ok);
  },
});

// Bersihkan nama file: buang path & karakter aneh, pastikan berakhiran .docx
function namaAman(nama) {
  const base = path.basename(nama).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.toLowerCase().endsWith(".docx") ? base : base + ".docx";
}

// .docx itu file ZIP → harus diawali "PK"
function bukanDocxValid(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(2);
  fs.readSync(fd, buf, 0, 2, 0);
  fs.closeSync(fd);
  return buf.toString() !== "PK";
}

// =========================================================
// 5. SERVER EXPRESS
// =========================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.static("public")); // buat menyajikan halaman admin.html

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use("/api/", limiter);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", faqCount: faqList.length });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Format 'messages' tidak valid" });
    }

    const pesanUser = messages[messages.length - 1].content;

    const jawabanFaq = await cariFaqCocok(pesanUser);
    if (jawabanFaq) {
      return res.json({ reply: jawabanFaq, source: "faq" });
    }

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(pesanUser);

    res.json({ reply: result.response.text(), source: "ai" });
  } catch (err) {
    console.error("Error /api/chat:", err.message);
    res.status(500).json({ error: "Terjadi kendala di server, coba lagi sebentar." });
  }
});

// --- Endpoint khusus admin (wajib password) ---

// Cek password valid (dipakai halaman admin buat verifikasi sebelum tampilkan form)
app.post("/api/admin/login", cekAdmin, (req, res) => {
  res.json({ status: "ok" });
});

// Daftar semua file .docx yang sedang dipakai chatbot
app.get("/api/admin/files", cekAdmin, (req, res) => {
  const files = daftarFileDocx().map((name) => {
    const st = fs.statSync(path.join(DATA_DIR, name));
    return { name, size: st.size, modified: st.mtime, entries: fileStats[name] ?? 0 };
  });
  res.json({ files, faqCount: faqList.length });
});

// Upload satu atau banyak file .docx sekaligus (nama sama = menimpa file lama)
app.post("/api/admin/upload-faq", cekAdmin, upload.array("files", 20), async (req, res) => {
  const uploaded = req.files || [];
  try {
    if (uploaded.length === 0) return res.status(400).json({ error: "Tidak ada file dikirim" });

    const tersimpan = [];
    const ditolak = [];
    for (const f of uploaded) {
      if (bukanDocxValid(f.path)) {
        ditolak.push(f.originalname);
        continue;
      }
      const nama = namaAman(f.originalname);
      fs.copyFileSync(f.path, path.join(DATA_DIR, nama));
      tersimpan.push(nama);
    }

    await muatSemuaFaq();
    res.json({ status: "ok", tersimpan, ditolak, faqCount: faqList.length });
  } catch (err) {
    console.error("Gagal upload FAQ:", err.message);
    res.status(500).json({ error: "Gagal memproses file" });
  } finally {
    for (const f of uploaded) fs.rmSync(f.path, { force: true });
  }
});

// Hapus satu file .docx
app.delete("/api/admin/files/:name", cekAdmin, async (req, res) => {
  const nama = path.basename(req.params.name);
  const target = path.join(DATA_DIR, nama);
  if (!nama.toLowerCase().endsWith(".docx") || !fs.existsSync(target)) {
    return res.status(404).json({ error: "File tidak ditemukan" });
  }
  fs.unlinkSync(target);
  await muatSemuaFaq();
  res.json({ status: "ok", faqCount: faqList.length });
});

// Refresh manual tanpa upload baru (baca ulang semua file yang ada)
app.post("/api/admin/reload-faq", cekAdmin, async (req, res) => {
  await muatSemuaFaq();
  res.json({ status: "ok", faqCount: faqList.length });
});

// Error handler (mis. multer menolak file bukan .docx)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// =========================================================
// 6. JALANKAN SERVER
// =========================================================
app.listen(PORT, async () => {
  console.log(`🚀 Server jalan di http://localhost:${PORT}`);
  await muatSemuaFaq();
  setInterval(muatSemuaFaq, RELOAD_INTERVAL_MS);
});
