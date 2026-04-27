import TelegramBot from "node-telegram-bot-api";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, ChildProcess } from "child_process";
import { logger } from "./lib/logger.js";
import { isMtProtoAvailable, getMtProtoClient, downloadViaMtProto } from "./gramjsClient.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");

// ─── Local Bot API Server ─────────────────────────────────────────────────────
// Runs the local Telegram Bot API server to bypass the 20 MB file download limit.
// Files up to 2000 MB can be downloaded when using the local server.

// Port 8787 avoids conflict with Vite/mockup-sandbox (which uses 8081-8085 range)
const LOCAL_BOT_API_PORT = 8787;
const LOCAL_BOT_API_BASE = `http://127.0.0.1:${LOCAL_BOT_API_PORT}`;

// Binary search order: env var → standard Linux path → Replit Nix store
const TG_BOT_API_BIN_CANDIDATES = [
  process.env["TG_BOT_API_BIN"],
  "/usr/local/bin/telegram-bot-api",
  "/nix/store/8lna1zsjag85d0fml9gjmhab899ffqfw-telegram-bot-api-8.2/bin/telegram-bot-api",
].filter(Boolean) as string[];

const TG_BOT_API_BIN = TG_BOT_API_BIN_CANDIDATES.find(p => fs.existsSync(p)) ?? "";

// Log binary resolution at startup
logger.info({
  candidates: TG_BOT_API_BIN_CANDIDATES,
  resolved: TG_BOT_API_BIN || "(not found)",
  exists: TG_BOT_API_BIN ? fs.existsSync(TG_BOT_API_BIN) : false,
}, "telegram-bot-api binary resolution");

let localApiProcess: ChildProcess | null = null;
let usingLocalServer = false;

async function startLocalBotApiServer(): Promise<void> {
  const apiId = process.env["TELEGRAM_API_ID"];
  const apiHash = process.env["TELEGRAM_API_HASH"];

  if (!apiId || !apiHash) {
    logger.warn("TELEGRAM_API_ID or TELEGRAM_API_HASH not set — local bot API server disabled (20 MB limit applies)");
    return;
  }

  if (!TG_BOT_API_BIN || !fs.existsSync(TG_BOT_API_BIN)) {
    logger.warn({ checked: TG_BOT_API_BIN_CANDIDATES }, "telegram-bot-api binary not found in any candidate path — local bot API server disabled");
    return;
  }

  logger.info({ bin: TG_BOT_API_BIN, port: LOCAL_BOT_API_PORT }, "Starting local Telegram Bot API server");

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
        `--verbosity=2`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    localApiProcess = proc;

    let resolved = false;
    let exited = false;

    const onData = (chunk: Buffer) => {
      const line = chunk.toString();
      // Forward all server output to our logger so we can see what's happening
      process.stderr.write(`[tg-api] ${line}`);
      if (line.includes("Start to receive") || line.includes("listening") || line.includes("LISTENING")) {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      logger.error({ err, bin: TG_BOT_API_BIN }, "Local bot API server spawn error — binary may be incompatible");
      if (!resolved) { resolved = true; reject(err); }
    });

    proc.on("exit", (code, signal) => {
      exited = true;
      localApiProcess = null;
      if (!resolved) {
        logger.error({ code, signal, bin: TG_BOT_API_BIN }, "Local bot API server exited before becoming ready");
        resolved = true;
        reject(new Error(`telegram-bot-api exited with code ${code} before ready`));
      } else {
        logger.warn({ code, signal }, "Local bot API server exited");
      }
    });

    // Give it up to 30s to start before proceeding
    setTimeout(() => {
      if (!resolved && !exited) {
        logger.info("Local bot API server startup timeout reached — proceeding to readiness probe");
        resolved = true;
        resolve();
      }
    }, 30_000);
  });
}

// Probe the local server — verify it's actually a Telegram Bot API server
// (not a Vite dev server or other HTTP process on the same port)
async function isLocalServerReady(): Promise<boolean> {
  try {
    const res = await axios.get(`${LOCAL_BOT_API_BASE}/bot${token}/getMe`, {
      timeout: 2000,
      validateStatus: () => true,
    });
    // Telegram Bot API always returns JSON with an "ok" field
    if (typeof res.data === "object" && "ok" in res.data) return true;
    // Got a response but it's not a Telegram API server
    logger.warn("Port response is not a Telegram Bot API server — local server not ready yet");
    return false;
  } catch {
    return false;
  }
}

// Start without polling — initBot() will set up local server + polling
// Generous timeout for large media uploads via local Bot API server
const bot = new TelegramBot(token, {
  polling: false,
  request: {
    timeout: 5 * 60 * 1000, // 5 minutes per HTTP request
    forever: true,           // keep-alive connections
  } as any,
});

export async function initBot() {
  // Try to start local bot API server for large file support
  const apiId = process.env["TELEGRAM_API_ID"];
  const apiHash = process.env["TELEGRAM_API_HASH"];

  if (apiId && apiHash) {
    try {
      await startLocalBotApiServer();
      // Wait for server readiness
      let serverReady = false;
      let attempts = 0;
      while (attempts < 30) {
        if (await isLocalServerReady()) { serverReady = true; break; }
        logger.info({ attempt: attempts + 1 }, "Waiting for local bot API server...");
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }
      // Only switch to local server if it actually started and responded
      if (serverReady) {
        (bot as any).options.baseApiUrl = LOCAL_BOT_API_BASE;
        usingLocalServer = true;
        logger.info({ port: LOCAL_BOT_API_PORT }, "Local bot API server ready — 2 GB file limit active");
      } else {
        logger.warn({ attempts }, "Local bot API server did not become ready in time — falling back to standard 20 MB limit");
      }
    } catch (err) {
      logger.warn({ err }, "Local bot API server failed to start — continuing with standard 20 MB limit");
    }
  }

  // Pre-connect MTProto (gramjs) client in background — enables large file download without binary
  if (isMtProtoAvailable()) {
    getMtProtoClient().catch(err => {
      logger.warn({ err }, "MTProto pre-connect failed — will retry on first large file");
    });
  } else {
    logger.warn("TELEGRAM_API_ID/TELEGRAM_API_HASH not set — large file support disabled (20 MB limit)");
  }

  // Clear any stale webhook first (ensures polling mode works cleanly)
  await bot.deleteWebHook().catch(err => {
    logger.warn({ err: err?.message }, "deleteWebHook failed — continuing anyway");
  });
  await bot.startPolling({ restart: false });
  logger.info("Telegram bot started with polling");
}

const OWNER_ID = 6762363593;

// ─── Storage channel routing ──────────────────────────────────────────────────
// If STORAGE_CHANNEL_ID is set, all media (images & PDFs) are sent to that channel
// instead of the owner's DM. Status messages always stay in DM.
// Bot must be added to the channel as an admin with "Post messages" permission.
const STORAGE_CHANNEL_ID_RAW = process.env["STORAGE_CHANNEL_ID"]?.trim();
const STORAGE_CHANNEL_ID: number | string | null = STORAGE_CHANNEL_ID_RAW
  ? (/^-?\d+$/.test(STORAGE_CHANNEL_ID_RAW) ? Number(STORAGE_CHANNEL_ID_RAW) : STORAGE_CHANNEL_ID_RAW)
  : null;

// ── Persistent toggle: channel ON/OFF ─────────────────────────────────────────
const STATE_FILE = path.join(process.cwd(), "bot-state.json");
let channelEnabled = true; // default ON if STORAGE_CHANNEL_ID is set

function loadChannelState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (typeof raw?.channelEnabled === "boolean") channelEnabled = raw.channelEnabled;
    }
  } catch { /* ignore */ }
}
function saveChannelState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ channelEnabled }));
  } catch { /* ignore */ }
}
loadChannelState();

function channelActive(): boolean {
  return STORAGE_CHANNEL_ID !== null && channelEnabled;
}

function targetChat(dmChatId: number): number | string {
  return channelActive() ? STORAGE_CHANNEL_ID! : dmChatId;
}
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

// ─── Awaiting deletion state (PDF flow) ───────────────────────────────────────
interface AwaitingDeletion {
  images: Buffer[];
  baseName: string;
  fileName: string;
  statusMsgId: number;
  ct: CancelToken;
}
const awaitingDeletion = new Map<number, AwaitingDeletion>();

function clearAwaitingDeletion(chatId: number) {
  awaitingDeletion.delete(chatId);
}

function parseDeletionList(input: string, max: number): { keep: Set<number>; del: number[] } {
  // Input examples: "3", "1,3,5", "2-7", "1,3,5-10,15"
  // Returns 1-indexed deletion list and complement set (0-indexed indices to keep)
  const delSet = new Set<number>();
  const tokens = input.split(/[,\s]+/).filter(Boolean);
  for (const tok of tokens) {
    const range = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1]!, 10);
      const b = parseInt(range[2]!, 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) {
        if (i >= 1 && i <= max) delSet.add(i);
      }
    } else if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (n >= 1 && n <= max) delSet.add(n);
    }
  }
  const keep = new Set<number>();
  for (let i = 0; i < max; i++) if (!delSet.has(i + 1)) keep.add(i);
  return { keep, del: [...delSet].sort((a, b) => a - b) };
}

function cancelExistingJob(chatId: number): boolean {
  clearAwaitingDeletion(chatId);
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
  maxAttempts = 6
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (ct?.cancelled) throw new JobCancelledError();

      // 429 rate limit
      const retryAfterSec: number | undefined =
        err?.response?.body?.parameters?.retry_after ??
        (err?.response?.statusCode === 429 ? 30 : undefined);

      // Transient network / timeout errors
      const code = err?.code || err?.cause?.code || err?.response?.code;
      const msg: string = (err?.message || "").toLowerCase();
      const isTransient =
        code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" ||
        code === "ECONNRESET" || code === "ECONNREFUSED" ||
        code === "ECONNABORTED" || code === "ENOTFOUND" ||
        code === "EAI_AGAIN" || code === "EPIPE" ||
        code === "EFATAL" || err?.name === "EFATAL" || err?.name === "EPARSE" ||
        msg.includes("etimedout") || msg.includes("socket hang up") ||
        msg.includes("network") || msg.includes("timeout") ||
        msg.includes("aborted") || msg.includes("econnreset");

      let waitMs = 0;
      if (retryAfterSec !== undefined) {
        waitMs = (retryAfterSec + 1) * 1000;
        logger.warn({ retryAfterSec, attempt }, `429 rate limit — waiting ${retryAfterSec}s before retry`);
      } else if (isTransient) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 30s
        waitMs = Math.min(2000 * Math.pow(2, attempt), 30000);
        logger.warn({ code, attempt, msg: err?.message }, `transient error — retrying in ${waitMs}ms`);
      } else {
        throw err;
      }

      if (attempt >= maxAttempts - 1) throw err;

      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, waitMs);
        ct?.registerChild(() => { clearTimeout(t); rej(new JobCancelledError()); });
      }).finally(() => ct?.unregisterChild());
      if (ct?.cancelled) throw new JobCancelledError();
    }
  }
  throw lastErr ?? new Error("callWithRetry: exhausted attempts");
}

// ─── Pending files (MHT choice keyboard) ─────────────────────────────────────

interface PendingFile {
  fileId: string;
  fileName: string;
  timestamp: number;
  origMessageId: number;
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
  // ─── Step 0: Enforce Telegram photo dimension constraints ──────────────────
  // Telegram rejects photos where: width + height > 10000 OR ratio > 20:1
  const meta = await sharp(imgBuffer).metadata();
  const origW = meta.width ?? 1;
  const origH = meta.height ?? 1;
  let targetW = origW;
  let targetH = origH;

  // Fix: width + height must be ≤ 10000 (scale proportionally)
  if (targetW + targetH > 10000) {
    const scale = 9990 / (targetW + targetH);
    targetW = Math.max(1, Math.floor(targetW * scale));
    targetH = Math.max(1, Math.floor(targetH * scale));
  }

  // Fix: aspect ratio must be ≤ 20:1 (crop the excess from the long side)
  const ratio = Math.max(targetW, targetH) / Math.min(targetW, targetH);
  if (ratio > 20) {
    if (targetH > targetW) {
      targetH = Math.floor(targetW * 20);
    } else {
      targetW = Math.floor(targetH * 20);
    }
  }

  if (targetW !== origW || targetH !== origH) {
    // Use fit:"cover" + position:"top" so we keep the top of tall manga strips
    imgBuffer = await sharp(imgBuffer)
      .resize({ width: targetW, height: targetH, fit: "cover", position: "top" })
      .toBuffer();
  }

  const writeTemp = (buf: Buffer): string => {
    const tmpPath = path.join(os.tmpdir(), `tg_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
  };

  // High-quality JPEG encoder that preserves text sharpness on manga pages.
  // mozjpeg + 4:4:4 chroma + trellis = much crisper text at same file size.
  const encode = (input: Buffer, quality: number, width?: number): Promise<Buffer> => {
    let p = sharp(input);
    if (width) p = p.resize({ width, withoutEnlargement: true, kernel: "lanczos3" });
    return p
      .jpeg({
        quality,
        mozjpeg: true,
        chromaSubsampling: "4:4:4",
        trellisQuantisation: true,
        progressive: true,
      })
      .toBuffer();
  };

  // ─── Step 1: native size, premium quality ladder (keeps text crisp) ──────
  for (const q of [95, 92, 90, 87, 85]) {
    const buf = await encode(imgBuffer, q);
    if (buf.length <= TG_PHOTO_MAX) return writeTemp(buf);
  }

  // ─── Step 2: gentle downscale, still high quality ───────────────────────
  // Keep width generous so text never falls below ~1600px on typical manga.
  for (const width of [2560, 2200, 1920, 1700, 1500]) {
    for (const q of [92, 88, 85, 82]) {
      const buf = await encode(imgBuffer, q, width);
      if (buf.length <= TG_PHOTO_MAX) return writeTemp(buf);
    }
  }

  // ─── Step 3: last resort — smallest acceptable size ─────────────────────
  const buf = await encode(imgBuffer, 75, 1280);
  return writeTemp(buf);
}

// ─── Media Groups ─────────────────────────────────────────────────────────────

// Direct sendMediaGroup (documents) bypassing node-telegram-bot-api.
// The library puts `media` in the URL query string, which the local Bot API
// server cannot parse for sendMediaGroup — causing a "Wrong file identifier"
// error. Building the multipart body manually with everything inside fixes it.
async function sendDocumentGroupDirect(chatId: number, filePaths: string[]): Promise<void> {
  const baseApiUrl = (bot as any).options.baseApiUrl ?? "https://api.telegram.org";
  const url = `${baseApiUrl}/bot${token}/sendMediaGroup`;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media = filePaths.map((_, i) => ({ type: "document", media: `attach://${i}` }));
  form.append("media", JSON.stringify(media));
  filePaths.forEach((fp, i) => {
    form.append(String(i), fs.createReadStream(fp), {
      filename: path.basename(fp),
      contentType: "application/octet-stream",
    });
  });

  try {
    await axios.post(url, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 5 * 60_000, // 5 minutes — large document groups can be slow
    });
  } catch (err: any) {
    const desc = err?.response?.data?.description ?? err?.message ?? "unknown";
    const status = err?.response?.status;
    const wrapped: any = new Error(`ETELEGRAM: ${status ?? ""} ${desc}`.trim());
    wrapped.code = "ETELEGRAM";
    wrapped.response = err?.response;
    throw wrapped;
  }
}

async function sendImagesAsMediaGroups(
  chatId: number,
  images: Buffer[],
  baseName: string,
  statusMsgId: number,
  ct: CancelToken,
  mode: "doc" | "photo" = "doc",
): Promise<void> {
  const tempFiles: string[] = [];

  // Unique scratch dir → lets each file have its full pretty display name on disk.
  const tempDir = path.join(os.tmpdir(), `mht_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Sanitize baseName for use in a filename: drop filesystem-illegal chars and
  // truncate so the final filename stays comfortably short for HTTP headers.
  const safeBase = baseName
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .trim()
    .slice(0, 40) || "chapter";

  try {
    if (mode === "doc") {
      // DOCUMENTS — Telegram does NOT recompress, text stays razor-sharp.
      for (let i = 0; i < images.length; i++) {
        ct.throwIfCancelled();
        const meta = await sharp(images[i]).metadata().catch(() => ({ format: "jpeg" as const }));
        const ext = (meta.format === "png" ? "png"
                  : meta.format === "webp" ? "webp"
                  : meta.format === "gif"  ? "gif"
                  : "jpg");
        const fileName = `poto ${i + 1} - ${safeBase} - [ Manhwa by Luna ].${ext}`;
        const tmpPath = path.join(tempDir, fileName);
        fs.writeFileSync(tmpPath, images[i]);
        tempFiles.push(tmpPath);
      }
    } else {
      // PHOTOS — compress to Telegram-friendly size (faster preview, smaller).
      for (let i = 0; i < images.length; i++) {
        ct.throwIfCancelled();
        const compressedPath = await compressForTelegram(images[i]);
        tempFiles.push(compressedPath);
      }
    }

    const groupSize = 10;
    const totalGroups = Math.ceil(images.length / groupSize);

    for (let g = 0; g < totalGroups; g++) {
      ct.throwIfCancelled();

      const start = g * groupSize;
      const end = Math.min(start + groupSize, images.length);
      const groupFiles = tempFiles.slice(start, end);

      // Update status every group so user sees real progress
      bot.editMessageText(
        `⏳ ပို့နေသည်... (${g + 1}/${totalGroups} အုပ်စု — ပုံ ${start + 1}–${end})`,
        { chat_id: chatId, message_id: statusMsgId }
      ).catch(() => { /* edit errors are harmless */ });

      if (mode === "doc") {
        await callWithRetry(() => sendDocumentGroupDirect(targetChat(chatId), groupFiles), ct);
      } else {
        const media = groupFiles.map((fp) => ({
          type: "photo" as const,
          media: fs.createReadStream(fp),
        }));
        await callWithRetry(() => bot.sendMediaGroup(targetChat(chatId), media), ct);
      }

      if (g < totalGroups - 1) {
        // 1.5s delay between groups to avoid rate limits (429 retry handles edge cases)
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 1500);
          ct.registerChild(() => { clearTimeout(t); rej(new JobCancelledError()); });
        }).finally(() => ct.unregisterChild());
      }
    }
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
  }
}

// ─── PDF finalization (after deletion choice) ────────────────────────────────

async function finalizePdf(
  chatId: number,
  state: AwaitingDeletion,
  keptIndices: number[] | null, // null = keep all
): Promise<void> {
  const { images, baseName, fileName, statusMsgId, ct } = state;
  const finalImages = keptIndices === null ? images : keptIndices.map(i => images[i]!);
  const removedCount = images.length - finalImages.length;
  let pdfPath: string | null = null;

  try {
    if (finalImages.length === 0) {
      await bot.editMessageText(`❌ ဖျက်ပြီးနောက် ပုံ မကျန်ပါ။ PDF လုပ်၍ မရပါ။`, {
        chat_id: chatId, message_id: statusMsgId,
      }).catch(() => {});
      return;
    }

    await bot.editMessageText(
      removedCount > 0
        ? `⏳ ${removedCount} ပုံ ဖျက်ပြီး PDF ဖန်တီးနေသည် (ကျန် ${finalImages.length} ပုံ)...`
        : `⏳ PDF ဖန်တီးနေသည် (${finalImages.length} ပုံ)...`,
      { chat_id: chatId, message_id: statusMsgId }
    ).catch(() => {});

    pdfPath = await createPdfFromImages(finalImages, ct);

    await callWithRetry(() =>
      bot.editMessageText(`⏳ PDF ပြုလုပ်ပြီ။ ပို့နေသည်...`, { chat_id: chatId, message_id: statusMsgId }), ct
    ).catch(() => {});

    await callWithRetry(() =>
      bot.sendDocument(
        targetChat(chatId),
        pdfPath!,
        {},
        { filename: `${baseName}.pdf`, contentType: "application/pdf" }
      ), ct
    );

    await bot.deleteMessage(chatId, statusMsgId).catch(() => {});
    logger.info({ chatId, fileName, kept: finalImages.length, removed: removedCount }, "PDF sent");
  } catch (err) {
    if (err instanceof JobCancelledError) {
      bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: statusMsgId })
        .catch(() => bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။"));
    } else {
      logger.error({ err, chatId, fileName }, "PDF send error");
      bot.editMessageText(
        `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
        { chat_id: chatId, message_id: statusMsgId }
      ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
    }
  } finally {
    if (pdfPath && fs.existsSync(pdfPath)) { try { fs.unlinkSync(pdfPath); } catch { /* ignore */ } }
    clearAwaitingDeletion(chatId);
    finishJob(chatId, ct);
  }
}

// ─── Download helper ──────────────────────────────────────────────────────────

async function downloadFile(
  fileId: string,
  fileName: string,
  chatId: number,
  statusMsgId: number,
  ct: CancelToken,
  origMessageId?: number
): Promise<Buffer> {
  ct.throwIfCancelled();
  await bot.editMessageText(
    `⏳ "${fileName}"\nဖိုင် ဒေါင်းလုပ် ဆွဲနေသည်...`,
    { chat_id: chatId, message_id: statusMsgId }
  );

  // ── Try standard Bot API getFile first (works up to 20 MB) ──────────────────
  let fileInfo: TelegramBot.File | null = null;
  try {
    fileInfo = await bot.getFile(fileId);
  } catch (err: any) {
    // Files >20 MB fail getFile on the standard API — expected
    logger.warn({ err: err?.message }, "getFile failed (file may be >20 MB), will try MTProto");
  }
  ct.throwIfCancelled();

  if (fileInfo?.file_path) {
    if (usingLocalServer) {
      // Local server (--local mode) stores files on disk — read directly
      return await new Promise<Buffer>((resolve, reject) => {
        fs.readFile(fileInfo!.file_path!, (err, data) => {
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

  // ── Fallback: MTProto via gramjs (no binary needed, needs API_ID + API_HASH) ─
  if (origMessageId && isMtProtoAvailable()) {
    await bot.editMessageText(
      `⏳ "${fileName}"\nMTProto ဖြင့် ဒေါင်းလုပ် ဆွဲနေသည်...`,
      { chat_id: chatId, message_id: statusMsgId }
    );

    let lastPct = -1;
    const buf = await downloadViaMtProto(chatId, origMessageId, async (dl, total) => {
      if (total > 0) {
        const pct = Math.floor((dl / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          try {
            await bot.editMessageText(
              `⏳ "${fileName}"\nMTProto ဒေါင်းလုပ် ${pct}% (${(dl / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`,
              { chat_id: chatId, message_id: statusMsgId }
            );
          } catch { /* ignore edit errors */ }
        }
      }
    });
    if (buf) return buf;
  }

  throw new Error(
    isMtProtoAvailable()
      ? "ဖိုင် download မဖြစ်ပါ (MTProto error — /status ဖြင့် စစ်ပါ)"
      : "ဖိုင် download မဖြစ်ပါ — TELEGRAM_API_ID / TELEGRAM_API_HASH မထည့်ရသေးပါ"
  );
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
      `/channel — Storage channel ON/OFF ပြောင်းရန်\n` +
      `/status — Local server / file limit အခြေအနေ ကြည့်ရန်\n` +
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

// ─── /status — show server status ────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const hasCredentials = !!(process.env["TELEGRAM_API_ID"] && process.env["TELEGRAM_API_HASH"]);
  const hasBinary = !!(TG_BOT_API_BIN && fs.existsSync(TG_BOT_API_BIN));

  const mtprotoStatus = isMtProtoAvailable()
    ? `🟢 MTProto (gramjs): ရသည် — 2 GB limit active`
    : `🔴 MTProto (gramjs): credentials မထည့်ရသေး`;

  const credStatus = hasCredentials
    ? `✅ API_ID / API_HASH: ထည့်ထားပြီ`
    : `❌ API_ID / API_HASH: မထည့်ရသေးပါ`;

  const serverStatus = usingLocalServer
    ? `🟢 Local binary server: ရပ်နေသည်`
    : `⚫ Local binary server: မသုံးပါ`;

  bot.sendMessage(
    msg.chat.id,
    `📊 Bot Status\n\n${mtprotoStatus}\n${credStatus}\n${serverStatus}`,
  );
});

// ─── /channel — toggle storage channel ON/OFF ────────────────────────────────
function channelStatusText(): string {
  if (STORAGE_CHANNEL_ID === null) {
    return `📡 Storage Channel: ⚙️ မသတ်မှတ်ထားပါ\n\nSTORAGE_CHANNEL_ID env var ကို သတ်မှတ်ပြီးမှ ON/OFF လုပ်နိုင်ပါမည်။\nယခု ပုံများကို DM သို့သာ ပို့ပါသည်။`;
  }
  const dest = channelEnabled ? `📡 Channel (${STORAGE_CHANNEL_ID})` : `💬 DM`;
  const state = channelEnabled ? "🟢 ON" : "🔴 OFF";
  return `Storage Channel: ${state}\n\nပုံများ ပို့မည့်နေရာ: ${dest}`;
}

function channelKeyboard() {
  if (STORAGE_CHANNEL_ID === null) return undefined;
  const label = channelEnabled ? "🔴 Channel ပိတ်ရန် (OFF)" : "🟢 Channel ဖွင့်ရန် (ON)";
  return {
    reply_markup: {
      inline_keyboard: [[{ text: label, callback_data: "channel_toggle" }]],
    },
  };
}

bot.onText(/\/channel/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(msg.chat.id, channelStatusText(), channelKeyboard());
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
  // usingLocalServer → up to 2 GB via local bot-api binary
  // isMtProtoAvailable() → up to 2 GB via gramjs MTProto (no binary needed)
  // otherwise → 20 MB standard limit
  const canHandleLarge = usingLocalServer || isMtProtoAvailable();
  const TG_DOWNLOAD_MAX = canHandleLarge ? 2000 * 1024 * 1024 : 20 * 1024 * 1024;
  const fileSize = document.file_size ?? 0;
  if (fileSize > TG_DOWNLOAD_MAX) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    const hint = `\n\n⚙️ ကြီးသောဖိုင် (300MB အထိ) ပို့ဖို့ Render dashboard မှာ TELEGRAM_API_ID နဲ့ TELEGRAM_API_HASH ထည့်ပါ။`;
    bot.sendMessage(
      chatId,
      `❌ ဖိုင် "${fileName}" သည် ${sizeMB} MB ရှိ၍ 20 MB ကန့်သတ်ချက်ကျော်နေပါသည်။${hint}`
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
      const pdfBuffer = await downloadFile(document.file_id, fileName, chatId, statusMsgId, ct, msg.message_id);

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
          .catch(() => {});
        bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။").catch(() => {});
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, chatId, fileName }, "PDF processing error");
        bot.editMessageText(`❌ အမှားဖြစ်သည်:\n${errMsg}`, { chat_id: chatId, message_id: statusMsgId })
          .catch(() => {});
        // Always also send a new message so user sees it even if edit fails
        bot.sendMessage(chatId, `❌ PDF လုပ်ဆောင်ရာ အမှားဖြစ်သည်:\n${errMsg.slice(0, 200)}`).catch(() => {});
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
  pendingFiles.set(chatId, { fileId: document.file_id, fileName, timestamp: Date.now(), origMessageId: msg.message_id });

  await bot.sendMessage(
    chatId,
    `📂 "${fileName}" လက်ခံရပြီ!\n\nပုံများကို မည်သို့ ပို့ပေးရမလဲ?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📄 PDF အဖြစ် ပြောင်းပြီး ပို့", callback_data: "send_pdf" }],
          [{ text: "🖼 Media Group (ပုံအဖြစ်)", callback_data: "send_images_photo" }],
          [{ text: "📎 JPG Document (အရည်အသွေးပြည့်)", callback_data: "send_images_doc" }],
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

  // ── Channel ON/OFF toggle (independent of pending files) ────────────────────
  if (action === "channel_toggle") {
    if (STORAGE_CHANNEL_ID === null) {
      await bot.editMessageText(channelStatusText(), {
        chat_id: chatId, message_id: messageId,
      }).catch(() => {});
      return;
    }
    channelEnabled = !channelEnabled;
    saveChannelState();
    await bot.editMessageText(channelStatusText(), {
      chat_id: chatId, message_id: messageId,
      ...channelKeyboard(),
    }).catch(() => {});
    return;
  }

  // ── PDF deletion: Skip — keep all images and finalize ──────────────────────
  if (action === "pdf_skip_delete") {
    const state = awaitingDeletion.get(chatId);
    if (!state) {
      await bot.editMessageText(`⚠️ မရှိတော့ပါ။ ဖိုင်ကို ပြန်ပို့ပါ။`, {
        chat_id: chatId, message_id: messageId,
      }).catch(() => {});
      return;
    }
    await finalizePdf(chatId, state, null);
    return;
  }

  // ── PDF deletion: Cancel the whole PDF job ─────────────────────────────────
  if (action === "pdf_cancel_delete") {
    const wasRunning = cancelExistingJob(chatId);
    await bot.editMessageText(
      wasRunning ? `🛑 PDF လုပ်ငန်း ဖျက်လိုက်ပြီ။` : `🛑 ဖျက်လိုက်ပြီ။`,
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});
    return;
  }

  const pending = pendingFiles.get(chatId);

  if (!pending) {
    await bot.editMessageText(`⚠️ ဖိုင် မတွေ့ပါ။ ဖိုင်ကို ထပ်မံ ပို့ပြီး ကြိုးစားပါ။`, {
      chat_id: chatId, message_id: messageId,
    });
    return;
  }

  pendingFiles.delete(chatId);
  const { fileId, fileName, origMessageId: origMsgId } = pending;
  const baseName = path.basename(fileName, path.extname(fileName));

  const ct = startJob(chatId);

  // ── MHT → PDF (Step 1: download + extract, then ask for deletion list) ─────
  if (action === "send_pdf") {
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    try {
      const mhtBuffer = await downloadFile(fileId, fileName, chatId, messageId, ct, origMsgId);

      await bot.editMessageText(`⏳ "${fileName}"\nပုံများ ရှာဖွေနေသည်...`, {
        chat_id: chatId, message_id: messageId,
      });

      const images = await extractImagesFromMht(mhtBuffer, ct);

      if (images.length === 0) {
        await bot.editMessageText(`❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`, { chat_id: chatId, message_id: messageId });
        finishJob(chatId, ct);
        return;
      }

      // Save state and prompt the owner to mark images for deletion
      awaitingDeletion.set(chatId, {
        images, baseName, fileName, statusMsgId: messageId, ct,
      });

      await bot.editMessageText(
        `📑 ပုံ ${images.length} ပုံ တွေ့ပြီ။\n\n` +
        `❓ ဖျက်ချင်တဲ့ ပုံနံပါတ်ကို ရိုက်ပါ\n` +
        `ဥပမာ: \`3\`  သို့မဟုတ် \`1,3,5\`  သို့မဟုတ် \`2-7\`  သို့မဟုတ် \`1,3,5-10,15\`\n\n` +
        `ဖျက်စရာ မရှိရင် "⏭ Skip" ကို နှိပ်ပါ။`,
        {
          chat_id: chatId, message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⏭ Skip — အားလုံး PDF လုပ်မည်", callback_data: "pdf_skip_delete" }],
              [{ text: "🛑 ဖျက်ပါ", callback_data: "pdf_cancel_delete" }],
            ],
          },
        }
      );
      // NOTE: we keep the job alive (do NOT call finishJob). It will be
      // finalized by finalizePdf() after the owner replies.
    } catch (err) {
      if (err instanceof JobCancelledError) {
        bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: messageId })
          .catch(() => bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။"));
      } else {
        logger.error({ err, chatId, fileName }, "PDF prep error");
        bot.editMessageText(
          `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
          { chat_id: chatId, message_id: messageId }
        ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
      }
      clearAwaitingDeletion(chatId);
      finishJob(chatId, ct);
    }

  // ── MHT → Images ─────────────────────────────────────────────────────────────
  } else if (action === "send_images_doc" || action === "send_images_photo") {
    const sendMode: "doc" | "photo" = action === "send_images_doc" ? "doc" : "photo";
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    try {
      const mhtBuffer = await downloadFile(fileId, fileName, chatId, messageId, ct, origMsgId);

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

      await sendImagesAsMediaGroups(chatId, images, baseName, messageId, ct, sendMode);
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      logger.info({ chatId, fileName, imageCount: images.length, sendMode }, "Images sent as media groups");
    } catch (err) {
      if (err instanceof JobCancelledError) {
        bot.editMessageText(`🛑 ဖျက်လိုက်ပြီ။`, { chat_id: chatId, message_id: messageId })
          .catch(() => {});
        bot.sendMessage(chatId, "🛑 ဖျက်လိုက်ပြီ။").catch(() => {});
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, chatId, fileName }, "Images send error");
        bot.editMessageText(`❌ အမှားဖြစ်သည်:\n${errMsg}`, { chat_id: chatId, message_id: messageId })
          .catch(() => {});
        // Always also send a new message so user sees it even if edit fails
        bot.sendMessage(chatId, `❌ ပုံများ ပို့ရာ အမှားဖြစ်သည်:\n${errMsg.slice(0, 200)}`).catch(() => {});
      }
    } finally {
      finishJob(chatId, ct);
    }
  }
});

// ─── Non-owner catch-all ─────────────────────────────────────────────────────
// Reply to any message from non-owners so they know the bot is private.
// ─── Owner deletion-list text input (during PDF flow) ────────────────────────
bot.on("message", async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const chatId = msg.chat.id;
  const state = awaitingDeletion.get(chatId);
  if (!state) return;
  const text = msg.text?.trim();
  if (!text) return;
  if (text.startsWith("/")) return;        // commands handled elsewhere
  if (msg.document) return;                // documents handled elsewhere

  // Validate format: digits / commas / dashes / spaces only
  if (!/^[\d,\s\-]+$/.test(text)) {
    await bot.sendMessage(
      chatId,
      `⚠️ ပုံနံပါတ် format မမှန်ပါ။\nဥပမာ: \`3\`, \`1,3,5\`, \`2-7\`, \`1,3,5-10,15\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const { keep, del } = parseDeletionList(text, state.images.length);
  if (del.length === 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ ဖျက်စရာ ပုံ မရှိပါ (1 မှ ${state.images.length} အတွင်း ထည့်ပါ)။`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `✅ ဖျက်မည့်ပုံ ${del.length} ပုံ: ${del.slice(0, 30).join(", ")}${del.length > 30 ? "…" : ""}`
  );

  await finalizePdf(chatId, state, [...keep].sort((a, b) => a - b));
});

bot.on("message", (msg) => {
  if (isOwner(msg.from?.id)) return;
  bot.sendMessage(msg.chat.id, "🔒 ဤ bot သည် private use ဖြစ်သောကြောင့် သင်အသုံးမပြုနိုင်ပါ။");
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
