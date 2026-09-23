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
const FAQ_PATH = path.join(DATA_DIR, "faq.docx");

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
// 2. BACA FAQ DARI FILE LOKAL (bukan Google Drive lagi)
// =========================================================
let faqList = []; // [{ question, answer }]

async function muatFaqDariFile() {
  if (!fs.existsSync(FAQ_PATH)) {
    console.warn("⚠️  File faq.docx belum ada di ./data — upload lewat halaman admin dulu.");
    faqList = [];
    return;
  }
  const result = await mammoth.extractRawText({ path: FAQ_PATH });
  const text = result.value;

  const blocks = text.split(/\n(?=Q:)/).filter((b) => b.trim().startsWith("Q:"));

  faqList = blocks
    .map((block) => {
      const q = block.match(/Q:\s*(.+)/)?.[1]?.trim();
      const a = block.match(/A:\s*([\s\S]+)/)?.[1]?.trim();
      return { question: q, answer: a };
    })
    .filter((item) => item.question && item.answer);

  console.log(`✅ FAQ dimuat dari file lokal (${faqList.length} entri) — ${new Date().toLocaleTimeString("id-ID")}`);
}

// Pantau file: begitu file diganti (lewat admin upload atau SFTP manual), otomatis dimuat ulang.
// Tetap ada juga jadwal berkala sebagai jaring pengaman.
fs.watch(DATA_DIR, (eventType, filename) => {
  if (filename === "faq.docx") {
    muatFaqDariFile().catch((err) => console.error("Gagal reload otomatis:", err.message));
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
  limits: { fileSize: 10 * 1024 * 1024 }, // maks 10MB
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith(".docx");
    cb(ok ? null : new Error("File harus berformat .docx"), ok);
  },
});

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

// Upload file .docx baru — mengganti file lama
app.post("/api/admin/upload-faq", cekAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Tidak ada file dikirim" });

    fs.copyFileSync(req.file.path, FAQ_PATH); // replace file lama
    fs.unlinkSync(req.file.path); // hapus file sementara

    await muatFaqDariFile();
    res.json({ status: "ok", faqCount: faqList.length });
  } catch (err) {
    console.error("Gagal upload FAQ:", err.message);
    res.status(500).json({ error: "Gagal memproses file" });
  }
});

// Refresh manual tanpa upload baru (baca ulang file yang sudah ada)
app.post("/api/admin/reload-faq", cekAdmin, async (req, res) => {
  await muatFaqDariFile();
  res.json({ status: "ok", faqCount: faqList.length });
});

// =========================================================
// 6. JALANKAN SERVER
// =========================================================
app.listen(PORT, async () => {
  console.log(`🚀 Server jalan di http://localhost:${PORT}`);
  await muatFaqDariFile();
  setInterval(muatFaqDariFile, RELOAD_INTERVAL_MS);
});
