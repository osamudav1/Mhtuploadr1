import TelegramBot from "node-telegram-bot-api";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, ChildProcess } from "child_process";
import { logger } from "./lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");

// ─── Local Bot API Server ─────────────────────────────────────────────────────
// Runs the local Telegram Bot API server to bypass the 20 MB file download limit.
// Files up to 2000 MB can be downloaded when using the local server.

const LOCAL_BOT_API_PORT = 8082;
const LOCAL_BOT_API_BASE = `http://127.0.0.1:${LOCAL_BOT_API_PORT}`;

// Binary search order: env var → standard Linux path → Replit Nix store
const TG_BOT_API_BIN_CANDIDATES = [
  process.env["TG_BOT_API_BIN"],
  "/usr/local/bin/telegram-bot-api",
  "/nix/store/8lna1zsjag85d0fml9gjmhab899ffqfw-telegram-bot-api-8.2/bin/telegram-bot-api",
].filter(Boolean) as string[];

const TG_BOT_API_BIN = TG_BOT_API_BIN_CANDIDATES.find(p => fs.existsSync(p)) ?? "";

let localApiProcess: ChildProcess | null = null;
let usingLocalServer = false;

async function startLocalBotApiServer(): Promise<void> {
  const apiId = process.env["TELEGRAM_API_ID"];
  const apiHash = process.env["TELEGRAM_API_HASH"];

  if (!apiId || !apiHash) {
    logger.warn("TELEGRAM_API_ID or TELEGRAM_API_HASH not set — local bot API server disabled (20 MB limit applies)");
    return;
  }

  if (!fs.existsSync(TG_BOT_API_BIN)) {
    logger.warn("telegram-bot-api binary not found — local bot API server disabled");
    return;
  }

  const workDir = path.join(os.tmpdir(), "tg-bot-api");
  fs.mkdirSync(workDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      TG_BOT_API_BIN,
      [
        `--api-id=${apiId}`,
        `--api-hash=${apiHash}`,
        `--local`,
        `--http-port=${LOCAL_BOT_API_PORT}`,
        `--dir=${workDir}`,
        `--temp-dir=${os.tmpdir()}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    localApiProcess = proc;

    let ready = false;

    const onData = (chunk: Buffer) => {
      const line = chunk.toString();
      if (line.includes("Start to receive") || line.includes("listening") || line.includes("LISTENING")) {
        if (!ready) {
          ready = true;
          resolve();
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      logger.error({ err }, "Local bot API server error");
      if (!ready) reject(err);
    });

    proc.on("exit", (code) => {
      logger.warn({ code }, "Local bot API server exited");
      localApiProcess = null;
    });

    // Give it up to 10s to start
    setTimeout(() => {
      if (!ready) {
        ready = true;
        resolve(); // resolve anyway — server might still be starting
      }
    }, 10_000);
  });
}

// Probe the local server with a simple HTTP GET
async function isLocalServerReady(): Promise<boolean> {
  try {
    await axios.get(LOCAL_BOT_API_BASE, { timeout: 2000 });
    return true;
  } catch (e: any) {
    // 404 from the local server is fine — it means it's running
    if (e?.response?.status === 404 || e?.response?.status === 400) return true;
    return false;
  }
}

// Start without polling — initBot() will set up local server + polling
const bot = new TelegramBot(token, { polling: false });

export async function initBot() {
  // Try to start local bot API server for large file support
  const apiId = process.env["TELEGRAM_API_ID"];
  const apiHash = process.env["TELEGRAM_API_HASH"];

  if (apiId && apiHash) {
    try {
      await startLocalBotApiServer();
      // Wait for server readiness
      let attempts = 0;
      while (attempts < 15) {
        if (await isLocalServerReady()) break;
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }
      // Switch bot to use local server — library uses options.baseApiUrl
      (bot as any).options.baseApiUrl = LOCAL_BOT_API_BASE;
      usingLocalServer = true;
      logger.info({ port: LOCAL_BOT_API_PORT }, "Local bot API server ready — 2 GB file limit active");
    } catch (err) {
      logger.warn({ err }, "Local bot API server failed to start — continuing with standard 20 MB limit");
    }
  }

  // Clear any stale webhook first (ensures polling mode works cleanly)
  await bot.deleteWebHook();
  await bot.startPolling({ restart: false });
  logger.info("Telegram bot started with polling");
}

const OWNER_ID = 6762363593;
function isOwner(userId: number | undefined): boolean {
  return userId === OWNER_ID;
}

// ─── Cancellation ─────────────────────────────────────────────────────────────

class JobCancelledError extends Error {
  constructor() { super("CANCELLED"); this.name = "JobCancelledError"; }
}

class CancelToken {
  cancelled = false;
  private abortController = new AbortController();
  private childKill: (() => void) | null = null;

  get signal() { return this.abortController.signal; }

  registerChild(kill: () => void) { this.childKill = kill; }
  unregisterChild() { this.childKill = null; }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    try { this.childKill?.(); } catch { /* ignore */ }
  }

  throwIfCancelled() {
    if (this.cancelled) throw new JobCancelledError();
  }
}

// One active job per chatId
const activeJobs = new Map<number, CancelToken>();

function cancelExistingJob(chatId: number): boolean {
  const existing = activeJobs.get(chatId);
  if (existing) {
    existing.cancel();
    activeJobs.delete(chatId);
    return true;
  }
  return false;
}

function startJob(chatId: number): CancelToken {
  cancelExistingJob(chatId);
  const token = new CancelToken();
  activeJobs.set(chatId, token);
  return token;
}

function finishJob(chatId: number, token: CancelToken) {
  if (activeJobs.get(chatId) === token) activeJobs.delete(chatId);
}

// ─── 429 Retry Helper ─────────────────────────────────────────────────────────

async function callWithRetry<T>(
  fn: () => Promise<T>,
  ct?: CancelToken,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (ct?.cancelled) throw new JobCancelledError();
      const retryAfterSec: number | undefined =
        err?.response?.body?.parameters?.retry_after ??
        (err?.response?.statusCode === 429 ? 30 : undefined);
      if (retryAfterSec !== undefined && attempt < maxAttempts - 1) {
        const waitMs = (retryAfterSec + 1) * 1000;
        logger.warn({ retryAfterSec, attempt }, `429 rate limit — waiting ${retryAfterSec}s before retry`);
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, waitMs);
          ct?.registerChild(() => { clearTimeout(t); rej(new JobCancelledError()); });
        }).finally(() => ct?.unregisterChild());
        if (ct?.cancelled) throw new JobCancelledError();
      } else {
        throw err;
      }
    }
  }
  throw new Error("callWithRetry: exhausted attempts");
}

// ─── Pending files (MHT choice keyboard) ─────────────────────────────────────

interface PendingFile {
  fileId: string;
  fileName: string;
  timestamp: number;
}
const pendingFiles = new Map<number, PendingFile>();

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles.entries()) {
    if (now - file.timestamp > 10 * 60 * 1000) pendingFiles.delete(chatId);
  }
}, 60_000);

// ─── MHT Parsing ─────────────────────────────────────────────────────────────

interface ImagePart {
  buffer: Buffer;
  location: string;
  sortKey: number;
}

async function extractImagesFromMht(mhtContent: Buffer, ct: CancelToken): Promise<Buffer[]> {
  const headerSlice = mhtContent.slice(0, 4096).toString("utf8");
  const boundaryMatch = headerSlice.match(/boundary=(?:"([^"]+)"|([^\s;\r\n]+))/i);
  if (!boundaryMatch) throw new Error("MIME boundary not found in .mht file");
  const boundary = (boundaryMatch[1] ?? boundaryMatch[2]).trim();

  logger.info({ boundary }, "Parsed MIME boundary");

  const delim = Buffer.from("--" + boundary);
  const CRLF_CRLF = Buffer.from("\r\n\r\n");
  const LF_LF = Buffer.from("\n\n");

  const positions: number[] = [];
  let pos = 0;
  while (pos < mhtContent.length) {
    const idx = mhtContent.indexOf(delim, pos);
    if (idx === -1) break;
    positions.push(idx);
    pos = idx + delim.length;
  }

  const imageParts: ImagePart[] = [];

  for (let i = 0; i < positions.length; i++) {
    ct.throwIfCancelled();

    const partStart = positions[i] + delim.length;
    const partEnd = i + 1 < positions.length ? positions[i + 1] : mhtContent.length;
    const part = mhtContent.slice(partStart, partEnd);

    let sepIdx = part.indexOf(CRLF_CRLF);
    let sepLen = 4;
    if (sepIdx === -1) { sepIdx = part.indexOf(LF_LF); sepLen = 2; }
    if (sepIdx === -1) continue;

    const headerStr = part.slice(0, sepIdx).toString("utf8");
    if (!/content-type:\s*image\//i.test(headerStr)) continue;

    const headers: Record<string, string> = {};
    for (const line of headerStr.split(/\r?\n/)) {
      const ci = line.indexOf(":");
      if (ci === -1) continue;
      headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }

    const encoding = (headers["content-transfer-encoding"] ?? "base64").trim().toLowerCase();
    const location = headers["content-location"] ?? "";
    const bodyBuf = part.slice(sepIdx + sepLen);

    try {
      let imgBuffer: Buffer;
      if (encoding === "base64") {
        const b64str = bodyBuf.toString("ascii").replace(/\s/g, "");
        if (b64str.length < 10) continue;
        imgBuffer = Buffer.from(b64str, "base64");
      } else if (encoding === "quoted-printable") {
        const decoded = bodyBuf.toString("binary")
          .replace(/=\r\n/g, "").replace(/=\n/g, "")
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        imgBuffer = Buffer.from(decoded, "binary");
      } else {
        imgBuffer = Buffer.from(bodyBuf);
      }

      if (imgBuffer.length < 200) continue;

      const meta = await sharp(imgBuffer).metadata();
      if (!meta.width || !meta.height) continue;
      if (meta.width < 50 || meta.height < 50) continue;

      const fnMatch = location.match(/\/(\d+)\.\w+(?:\?.*)?$/);
      const sortKey = fnMatch ? parseInt(fnMatch[1], 10) : Infinity;

      imageParts.push({ buffer: imgBuffer, location, sortKey });
    } catch (err) {
      logger.warn({ location, err: String(err) }, "Skipping image part");
    }
  }

  const numericParts = imageParts.filter(p => p.sortKey !== Infinity).sort((a, b) => a.sortKey - b.sortKey);
  const nonNumericParts = imageParts.filter(p => p.sortKey === Infinity);
  const sorted = [...numericParts, ...nonNumericParts];

  logger.info({ total: sorted.length }, "MHT extraction complete");
  return sorted.map(p => p.buffer);
}

// ─── PDF → Images (pdftoppm) ──────────────────────────────────────────────────

async function extractImagesFromPdf(pdfBuffer: Buffer, ct: CancelToken): Promise<Buffer[]> {
  ct.throwIfCancelled();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf_"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");

  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    ct.throwIfCancelled();

    // Run pdftoppm as a spawned child so we can kill it on cancel
    await new Promise<void>((resolve, reject) => {
      const child = spawn("pdftoppm", ["-r", "200", "-png", pdfPath, outPrefix]);

      ct.registerChild(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      });

      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("close", (code) => {
        ct.unregisterChild();
        if (ct.cancelled) { reject(new JobCancelledError()); return; }
        if (code !== 0) reject(new Error(`pdftoppm failed (code ${code}): ${stderr.trim()}`));
        else resolve();
      });

      child.on("error", (err) => {
        ct.unregisterChild();
        reject(err);
      });
    });

    ct.throwIfCancelled();

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith("page") && f.endsWith(".png"))
      .sort();

    logger.info({ pageCount: files.length }, "PDF pages extracted");

    const buffers: Buffer[] = [];
    for (const file of files) {
      ct.throwIfCancelled();
      buffers.push(fs.readFileSync(path.join(tmpDir, file)));
    }
    return buffers;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ─── PDF creation ─────────────────────────────────────────────────────────────

async function createPdfFromImages(images: Buffer[], ct: CancelToken): Promise<string> {
  const pdfPath = path.join(os.tmpdir(), `manga_${Date.now()}.pdf`);
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
      const ws = fs.createWriteStream(pdfPath);
      doc.pipe(ws);

      for (const imgBuffer of images) {
        ct.throwIfCancelled();
        const meta = await sharp(imgBuffer).metadata();
        const w = meta.width ?? 595;
        const h = meta.height ?? 842;
        const jpeg = await sharp(imgBuffer).jpeg({ quality: 90 }).toBuffer();
        doc.addPage({ size: [w, h] });
        doc.image(jpeg, 0, 0, { width: w, height: h });
      }

      doc.end();
      ws.on("finish", () => resolve(pdfPath));
      ws.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Adaptive Image Compression ──────────────────────────────────────────────

const TG_PHOTO_MAX = 9.5 * 1024 * 1024; // Telegram photo limit ~10MB, use 9.5MB to be safe

async function compressForTelegram(imgBuffer: Buffer): Promise<string> {
  // Step 1: try decreasing JPEG quality at max width
  const widthSteps   = [2048, 1600, 1280, 1024, 800];
  const qualitySteps = [90, 80, 70, 60, 50, 40, 30];

  for (const quality of qualitySteps) {
    const buf = await sharp(imgBuffer)
      .jpeg({ quality })
      .resize({ width: 2048, withoutEnlargement: true })
      .toBuffer();
    if (buf.length <= TG_PHOTO_MAX) {
      const tmpPath = path.join(os.tmpdir(), `tg_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
      fs.writeFileSync(tmpPath, buf);
      return tmpPath;
    }
  }

  // Step 2: reduce both width and quality together
  for (const width of widthSteps) {
    for (const quality of [60, 50, 40, 30]) {
      const buf = await sharp(imgBuffer)
        .jpeg({ quality })
        .resize({ width, withoutEnlargement: true })
        .toBuffer();
      if (buf.length <= TG_PHOTO_MAX) {
        const tmpPath = path.join(os.tmpdir(), `tg_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
        fs.writeFileSync(tmpPath, buf);
        return tmpPath;
      }
    }
  }

  // Step 3: last resort — smallest acceptable size
  const buf = await sharp(imgBuffer)
    .jpeg({ quality: 25 })
    .resize({ width: 800, withoutEnlargement: true })
    .toBuffer();
  const tmpPath = path.join(os.tmpdir(), `tg_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// ─── Media Groups ─────────────────────────────────────────────────────────────

async function sendImagesAsMediaGroups(
  chatId: number,
  images: Buffer[],
  baseName: string,
  statusMsgId: number,
  ct: CancelToken
): Promise<void> {
  const tempFiles: string[] = [];

  try {
    for (let i = 0; i < images.length; i++) {
      ct.throwIfCancelled();
      const imgPath = await compressForTelegram(images[i]);
      tempFiles.push(imgPath);
    }

    const groupSize = 10;
    const totalGroups = Math.ceil(images.length / groupSize);

    for (let g = 0; g < totalGroups; g++) {
      ct.throwIfCancelled();

      const start = g * groupSize;
      const end = Math.min(start + groupSize, images.length);
      const groupFiles = tempFiles.slice(start, end);

      // Only update status every 3 groups (or first/last) to reduce API calls
      if (g === 0 || g === totalGroups - 1 || g % 3 === 0) {
        await callWithRetry(
          () => bot.editMessageText(
            `⏳ ပို့နေသည်... (${g + 1}/${totalGroups} အုပ်စု — ပုံ ${start + 1}–${end})`,
            { chat_id: chatId, message_id: statusMsgId }
          ),
          ct
        ).catch(() => {});
      }

      const media = groupFiles.map((filePath, idx) => ({
        type: "photo" as const,
        media: fs.createReadStream(filePath),
        ...(g === 0 && idx === 0
          ? { caption: `📚 ${baseName}\nပုံ ${images.length} ပုံ (${totalGroups} အုပ်စု)` }
          : {}),
      }));

      await callWithRetry(() => bot.sendMediaGroup(chatId, media), ct);

      if (g < totalGroups - 1) {
        // 3s delay between groups to avoid rate limits
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 3000);
          ct.registerChild(() => { clearTimeout(t); rej(new JobCancelledError()); });
        }).finally(() => ct.unregisterChild());
      }
    }
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// ─── Download helper ──────────────────────────────────────────────────────────

async function downloadFile(
  fileId: string,
  fileName: string,
  chatId: number,
  statusMsgId: number,
  ct: CancelToken
): Promise<Buffer> {
  ct.throwIfCancelled();
  await bot.editMessageText(
    `⏳ "${fileName}"\nဖိုင် ဒေါင်းလုပ် ဆွဲနေသည်...`,
    { chat_id: chatId, message_id: statusMsgId }
  );

  const fileInfo = await bot.getFile(fileId);
  ct.throwIfCancelled();

  if (usingLocalServer && fileInfo.file_path) {
    // Local server (--local mode) stores files on disk — read directly
    const localPath = fileInfo.file_path;
    return await new Promise<Buffer>((resolve, reject) => {
      fs.readFile(localPath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  // Standard cloud API — download via HTTP
  const baseApiUrl = (bot as any).options.baseApiUrl ?? "https://api.telegram.org";
  const fileUrl = `${baseApiUrl}/file/bot${token}/${fileInfo.file_path}`;
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    maxContentLength: 2000 * 1024 * 1024,
    signal: ct.signal,
  });
  return Buffer.from(response.data);
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `မင်္ဂလာပါ! 📚\n\n` +
      `ဖိုင် ၂ မျိုး လက်ခံသည်:\n\n` +
      `📄 .pdf ဖိုင် → ပုံများ တိုက်ရိုက် (10 ပုံစီ) ပို့ပေးသည်\n` +
      `🗂 .mht / .mhtml ဖိုင် → PDF သို့မဟုတ် ပုံများ ရွေးချယ်နိုင်သည်\n\n` +
      `ဖိုင်ကို Document အဖြစ် (ဖိုင်တိုက်ရိုက်) ပို့ပါ။\n\n` +
      `/cancel — လုပ်ဆောင်နေသော task ကို ဖျက်ရန်`
  );
});

bot.onText(/\/help/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `📖 အသုံးပြုနည်း:\n\n` +
      `【 PDF ဖိုင် 】\n` +
      `• .pdf ဖိုင် Document ပို့ပါ\n` +
      `• Bot က အလိုအလျောက် 10 ပုံစီ media group ပို့မည်\n\n` +
      `【 MHT ဖိုင် 】\n` +
      `• .mht / .mhtml ဖိုင် Document ပို့ပါ\n` +
      `• PDF အဖြစ် ပြောင်းပို့ (သို့) ပုံများ တိုက်ရိုက် ပို့ ရွေးနိုင်သည်\n\n` +
      `/cancel — လုပ်ဆောင်နေသော task ကို ဖျက်ရန်\n\n` +
      `⚠️ မှတ်ချက်: ဖိုင်ကို Photo မဟုတ်ဘဲ Document အဖြစ် ပို့ပါ`
  );
});

bot.onText(/\/cancel/, async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const chatId = msg.chat.id;
  const wasRunning = cancelExistingJob(chatId);
  pendingFiles.delete(chatId);
  if (wasRunning) {
    bot.sendMessage(chatId, "🛑 လုပ်ဆောင်နေသော task ကို ဖျက်လိုက်ပြီ။");
  } else {
    bot.sendMessage(chatId, "⚠️ ဖျက်စရာ task မရှိပါ။");
  }
});

// ─── Document Handler ────────────────────────────────────────────────────────

bot.on("document", async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const chatId = msg.chat.id;
  const document = msg.document;
  if (!document) return;

  const fileName = document.file_name ?? "";
  const lowerName = fileName.toLowerCase();

  const isMht =
    lowerName.endsWith(".mht") ||
    lowerName.endsWith(".mhtml") ||
    document.mime_type === "message/rfc822" ||
    document.mime_type === "multipart/related";

  const isPdf =
    lowerName.endsWith(".pdf") ||
    document.mime_type === "application/pdf";

  // ── File size guard ───────────────────────────────────────────────────────────
  // With local bot API server: up to 2000 MB. Without: 20 MB.
  // usingLocalServer is set at module level when local bot API server starts successfully
  const TG_DOWNLOAD_MAX = usingLocalServer ? 2000 * 1024 * 1024 : 20 * 1024 * 1024;
  const fileSize = document.file_size ?? 0;
  if (fileSize > TG_DOWNLOAD_MAX) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    const limitMB = usingLocalServer ? "2000" : "20";
    bot.sendMessage(
      chatId,
      `❌ ဖိုင် "${fileName}" သည် ${sizeMB} MB ရှိ၍ ${limitMB} MB ကန့်သတ်ချက်ကျော်နေပါသည်။\n\n` +
      `💡 chapter ကို ပိုင်းခြားပြီး ပို့ပါ။`
    );
    return;
  }

  // ── PDF ──────────────────────────────────────────────────────────────────────
  if (isPdf) {
    // Cancel any running job and start fresh
    const ct = startJob(chatId);
    const statusMsg = await bot.sendMessage(chatId, `⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`);
    const statusMsgId = statusMsg.message_id;
    const baseName = path.basename(fileName, ".pdf");

    try {
      const pdfBuffer = await downloadFile(document.file_id, fileName, chatId, statusMsgId, ct);

      await bot.editMessageText(`⏳ PDF ဖိုင်မှ ပုံများ ထုတ်နေသည်...`, {
        chat_id: chatId, message_id: statusMsgId,
      });

      const images = await extractImagesFromPdf(pdfBuffer, ct);

      if (images.length === 0) {
        await bot.editMessageText(`❌ PDF ထဲတွင် ပုံများ မတွေ့ပါ။`, {
          chat_id: chatId, message_id: statusMsgId,
        });
        return;
      }

      const totalGroups = Math.ceil(images.length / 10);
      await bot.editMessageText(
        `⏳ စာမျက်နှာ ${images.length} မျက်နှာ တွေ့ပြီ။ ${totalGroups} အုပ်စုနဲ့ ပို့မည်...`,
        { chat_id: chatId, message_id: statusMsgId }
      );

      await sendImagesAsMediaGroups(chatId, images, baseName, statusMsgId, ct);
      await bot.deleteMessage(chatId, statusMsgId).catch(() => {});
      logger.info({ chatId, fileName, pageCount: images.length }, "PDF pages sent as media groups");
    } catch (err) {
      if (err instanceof JobCancelledError) {
        bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: statusMsgId })
          .catch(() => bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။"));
      } else {
        logger.error({ err, chatId, fileName }, "PDF processing error");
        bot.editMessageText(
          `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
          { chat_id: chatId, message_id: statusMsgId }
        ).catch(() => bot.sendMessage(chatId, "❌ PDF လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
      }
    } finally {
      finishJob(chatId, ct);
    }
    return;
  }

  // ── MHT ──────────────────────────────────────────────────────────────────────
  if (!isMht) {
    bot.sendMessage(chatId, `❌ .mht / .mhtml / .pdf ဖိုင်သာ လက်ခံသည်။\nပေးပို့သော ဖိုင်: ${fileName}`);
    return;
  }

  // Cancel any running job before showing the keyboard
  cancelExistingJob(chatId);
  pendingFiles.set(chatId, { fileId: document.file_id, fileName, timestamp: Date.now() });

  await bot.sendMessage(
    chatId,
    `📂 "${fileName}" လက်ခံရပြီ!\n\nပုံများကို မည်သို့ ပို့ပေးရမလဲ?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📄 PDF အဖြစ် ပြောင်းပြီး ပို့", callback_data: "send_pdf" }],
          [{ text: "🖼 ပုံများ တိုက်ရိုက် ပို့ (10 ပုံစီ)", callback_data: "send_images" }],
        ],
      },
    }
  );
});

// ─── Callback Query Handler ───────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  if (!isOwner(query.from?.id)) return;
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  await bot.answerCallbackQuery(query.id);

  const action = query.data;
  const pending = pendingFiles.get(chatId);

  if (!pending) {
    await bot.editMessageText(`⚠️ ဖိုင် မတွေ့ပါ။ ဖိုင်ကို ထပ်မံ ပို့ပြီး ကြိုးစားပါ။`, {
      chat_id: chatId, message_id: messageId,
    });
    return;
  }

  pendingFiles.delete(chatId);
  const { fileId, fileName } = pending;
  const baseName = path.basename(fileName, path.extname(fileName));

  const ct = startJob(chatId);

  // ── MHT → PDF ────────────────────────────────────────────────────────────────
  if (action === "send_pdf") {
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    let pdfPath: string | null = null;
    try {
      const mhtBuffer = await downloadFile(fileId, fileName, chatId, messageId, ct);

      await bot.editMessageText(`⏳ "${fileName}"\nပုံများ ရှာဖွေနေသည်...`, {
        chat_id: chatId, message_id: messageId,
      });

      const images = await extractImagesFromMht(mhtBuffer, ct);

      if (images.length === 0) {
        await bot.editMessageText(`❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`, { chat_id: chatId, message_id: messageId });
        return;
      }

      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။ PDF ဖန်တီးနေသည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      pdfPath = await createPdfFromImages(images, ct);

      await callWithRetry(() =>
        bot.editMessageText(`⏳ PDF ပြုလုပ်ပြီ။ ပို့နေသည်...`, { chat_id: chatId, message_id: messageId }), ct
      ).catch(() => {});

      await callWithRetry(() =>
        bot.sendDocument(
          chatId,
          pdfPath!,
          { caption: `📄 ${baseName}.pdf\n✅ ပုံ ${images.length} ပုံ ပါဝင်သည်` },
          { filename: `${baseName}.pdf`, contentType: "application/pdf" }
        ), ct
      );

      await bot.deleteMessage(chatId, messageId).catch(() => {});
      logger.info({ chatId, fileName, imageCount: images.length }, "PDF sent");
    } catch (err) {
      if (err instanceof JobCancelledError) {
        bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: messageId })
          .catch(() => bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။"));
      } else {
        logger.error({ err, chatId, fileName }, "PDF send error");
        bot.editMessageText(
          `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
          { chat_id: chatId, message_id: messageId }
        ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
      }
    } finally {
      if (pdfPath && fs.existsSync(pdfPath)) { try { fs.unlinkSync(pdfPath); } catch { /* ignore */ } }
      finishJob(chatId, ct);
    }

  // ── MHT → Images ─────────────────────────────────────────────────────────────
  } else if (action === "send_images") {
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    try {
      const mhtBuffer = await downloadFile(fileId, fileName, chatId, messageId, ct);

      await bot.editMessageText(`⏳ "${fileName}"\nပုံများ ရှာဖွေနေသည်...`, {
        chat_id: chatId, message_id: messageId,
      });

      const images = await extractImagesFromMht(mhtBuffer, ct);

      if (images.length === 0) {
        await bot.editMessageText(`❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`, { chat_id: chatId, message_id: messageId });
        return;
      }

      const totalGroups = Math.ceil(images.length / 10);
      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။ ${totalGroups} အုပ်စုနဲ့ ပို့မည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      await sendImagesAsMediaGroups(chatId, images, baseName, messageId, ct);
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      logger.info({ chatId, fileName, imageCount: images.length }, "Images sent as media groups");
    } catch (err) {
      if (err instanceof JobCancelledError) {
        bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: messageId })
          .catch(() => bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။"));
      } else {
        logger.error({ err, chatId, fileName }, "Images send error");
        bot.editMessageText(
          `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
          { chat_id: chatId, message_id: messageId }
        ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
      }
    } finally {
      finishJob(chatId, ct);
    }
  }
});

bot.on("polling_error", (err: any) => {
  if (err?.response?.statusCode === 409) {
    // Another instance (production) is polling — stop dev polling to avoid conflict
    bot.stopPolling().catch(() => {});
    logger.warn("Dev polling stopped: production bot already running (409 conflict). Redeploy to activate new features.");
  } else {
    logger.error({ err }, "Telegram polling error");
  }
});

export { bot };
