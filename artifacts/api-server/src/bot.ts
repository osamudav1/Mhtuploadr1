import TelegramBot from "node-telegram-bot-api";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");

const bot = new TelegramBot(token, { polling: true });
logger.info("Telegram bot started with polling");

const OWNER_ID = 6762363593;
function isOwner(userId: number | undefined): boolean {
  return userId === OWNER_ID;
}

// Store pending file info waiting for user's choice
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
  location: string;   // Content-Location URL
  sortKey: number;    // numeric page number from filename, or Infinity
}

async function extractImagesFromMht(mhtContent: Buffer): Promise<Buffer[]> {
  // Read header to find boundary
  const headerSlice = mhtContent.slice(0, 4096).toString("utf8");
  const boundaryMatch = headerSlice.match(/boundary=(?:"([^"]+)"|([^\s;\r\n]+))/i);
  if (!boundaryMatch) throw new Error("MIME boundary not found in .mht file");
  const boundary = (boundaryMatch[1] ?? boundaryMatch[2]).trim();

  logger.info({ boundary }, "Parsed MIME boundary");

  // Work at Buffer level — no toString("binary") on the whole file
  const delim = Buffer.from("--" + boundary);
  const CRLF_CRLF = Buffer.from("\r\n\r\n");
  const LF_LF = Buffer.from("\n\n");

  // Collect start positions of every delimiter occurrence
  const positions: number[] = [];
  let pos = 0;
  while (pos < mhtContent.length) {
    const idx = mhtContent.indexOf(delim, pos);
    if (idx === -1) break;
    positions.push(idx);
    pos = idx + delim.length;
  }
  logger.info({ delimCount: positions.length }, "Found delimiter positions");

  const imageParts: ImagePart[] = [];

  for (let i = 0; i < positions.length; i++) {
    const partStart = positions[i] + delim.length;
    const partEnd = i + 1 < positions.length ? positions[i + 1] : mhtContent.length;
    const part = mhtContent.slice(partStart, partEnd);

    // Find headers/body separator (\r\n\r\n first, then \n\n)
    let sepIdx = part.indexOf(CRLF_CRLF);
    let sepLen = 4;
    if (sepIdx === -1) { sepIdx = part.indexOf(LF_LF); sepLen = 2; }
    if (sepIdx === -1) continue;

    const headerStr = part.slice(0, sepIdx).toString("utf8");

    // Skip non-image parts immediately
    if (!/content-type:\s*image\//i.test(headerStr)) continue;

    // Parse headers
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
        // bodyBuf is ASCII base64 with CRLF line breaks — decode at buffer level
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

      if (imgBuffer.length < 200) continue; // skip tiny/broken images

      // Validate dimensions
      const meta = await sharp(imgBuffer).metadata();
      if (!meta.width || !meta.height) continue;
      if (meta.width < 50 || meta.height < 50) continue; // skip icons/tiny UI elements

      // Extract numeric sort key from URL filename  e.g. ".../35.jpg" → 35
      const fnMatch = location.match(/\/(\d+)\.\w+(?:\?.*)?$/);
      const sortKey = fnMatch ? parseInt(fnMatch[1], 10) : Infinity;

      logger.info({ location, sortKey, width: meta.width, height: meta.height }, "Valid image part");
      imageParts.push({ buffer: imgBuffer, location, sortKey });
    } catch (err) {
      logger.warn({ location, err: String(err) }, "Skipping image part");
    }
  }

  // Sort: numeric filenames first (ascending page order), then non-numeric in original order
  const numericParts = imageParts.filter(p => p.sortKey !== Infinity).sort((a, b) => a.sortKey - b.sortKey);
  const nonNumericParts = imageParts.filter(p => p.sortKey === Infinity);
  const sorted = [...numericParts, ...nonNumericParts];

  logger.info(
    { total: sorted.length, numeric: numericParts.length, nonNumeric: nonNumericParts.length },
    "Extraction complete — sorted by page number"
  );

  return sorted.map(p => p.buffer);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function createPdfFromImages(images: Buffer[]): Promise<string> {
  const pdfPath = path.join(os.tmpdir(), `manga_${Date.now()}.pdf`);
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
      const ws = fs.createWriteStream(pdfPath);
      doc.pipe(ws);

      for (const imgBuffer of images) {
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

// ─── Media Group (images direct) ─────────────────────────────────────────────

async function sendImagesAsMediaGroups(
  chatId: number,
  images: Buffer[],
  baseName: string,
  statusMsgId: number
): Promise<void> {
  const tmpDir = os.tmpdir();
  const tempFiles: string[] = [];

  try {
    // Save all images as JPEG temp files in ORDER
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(tmpDir, `img_${Date.now()}_${String(i).padStart(5, "0")}.jpg`);
      await sharp(images[i])
        .jpeg({ quality: 90 })
        .resize({ width: 2048, withoutEnlargement: true }) // keep under Telegram limits
        .toFile(imgPath);
      tempFiles.push(imgPath);
    }

    const groupSize = 10;
    const totalGroups = Math.ceil(images.length / groupSize);

    for (let g = 0; g < totalGroups; g++) {
      const start = g * groupSize;
      const end = Math.min(start + groupSize, images.length);
      const groupFiles = tempFiles.slice(start, end);

      // Update status
      await bot.editMessageText(
        `⏳ ပို့နေသည်... (${g + 1}/${totalGroups} အုပ်စု — ပုံ ${start + 1}–${end})`,
        { chat_id: chatId, message_id: statusMsgId }
      ).catch(() => {});

      const media = groupFiles.map((filePath, idx) => ({
        type: "photo" as const,
        media: fs.createReadStream(filePath),
        ...(g === 0 && idx === 0
          ? { caption: `📚 ${baseName}\nပုံ ${images.length} ပုံ (${totalGroups} အုပ်စု)` }
          : {}),
      }));

      await bot.sendMediaGroup(chatId, media);

      // Respect Telegram flood limits between groups
      if (g < totalGroups - 1) {
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// ─── Helper: download + extract ──────────────────────────────────────────────

async function downloadAndExtract(
  fileId: string,
  fileName: string,
  chatId: number,
  statusMsgId: number
): Promise<Buffer[]> {
  await bot.editMessageText(
    `⏳ "${fileName}"\nဖိုင် ဒေါင်းလုပ် ဆွဲနေသည်...`,
    { chat_id: chatId, message_id: statusMsgId }
  );

  const fileLink = await bot.getFileLink(fileId);
  logger.info({ fileName }, "Downloading .mht file");

  const response = await axios.get(fileLink, {
    responseType: "arraybuffer",
    maxContentLength: 100 * 1024 * 1024, // 100 MB
  });
  const mhtBuffer = Buffer.from(response.data);

  await bot.editMessageText(
    `⏳ "${fileName}"\nပုံများ ရှာဖွေနေသည်...`,
    { chat_id: chatId, message_id: statusMsgId }
  );

  return extractImagesFromMht(mhtBuffer);
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `မင်္ဂလာပါ! 📚\n\n` +
      `.mht ဖိုင် (manga chapter) ကို Document အဖြစ် ပို့ပါ။\n\n` +
      `Bot က ပုံ‌တွေ ထုတ်ပြီး:\n` +
      `• 📄 PDF အဖြစ် ပြောင်းပြီး ပို့\n` +
      `• 🖼 ပုံများ တိုက်ရိုက် (10 ပုံစီ) ပို့\n\n` +
      `ဆိုသည့် နည်းနှစ်မျိုးထဲ ရွေးနိုင်သည်။`
  );
});

bot.onText(/\/help/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `📖 အသုံးပြုနည်း:\n\n` +
      `1. .mht ဖိုင်ကို Document အဖြစ် (ဖိုင်တိုက်ရိုက်) ပို့ပါ\n` +
      `2. Bot က ပုံ‌တွေ ထုတ်ပြီး နည်း ၂ မျိုး offer ပေးမည်\n` +
      `3. ကြိုက်သည့် နည်းကို ရွေးပါ\n\n` +
      `⚠️ မှတ်ချက်:\n` +
      `• ဖိုင်ကို Photo/Video မဟုတ်ဘဲ Document အဖြစ် ပို့ပါ\n` +
      `• .mht / .mhtml format သာ လက်ခံသည်`
  );
});

// ─── Document Handler ────────────────────────────────────────────────────────

bot.on("document", async (msg) => {
  if (!isOwner(msg.from?.id)) return;
  const chatId = msg.chat.id;
  const document = msg.document;
  if (!document) return;

  const fileName = document.file_name ?? "";
  const isMht =
    fileName.toLowerCase().endsWith(".mht") ||
    fileName.toLowerCase().endsWith(".mhtml") ||
    document.mime_type === "message/rfc822" ||
    document.mime_type === "multipart/related";

  if (!isMht) {
    bot.sendMessage(chatId, `❌ .mht သို့မဟုတ် .mhtml ဖိုင်သာ လက်ခံသည်။\nပေးပို့သော ဖိုင်: ${fileName}`);
    return;
  }

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

  // ── PDF ──
  if (action === "send_pdf") {
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    let pdfPath: string | null = null;
    try {
      const images = await downloadAndExtract(fileId, fileName, chatId, messageId);

      if (images.length === 0) {
        await bot.editMessageText(`❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`, { chat_id: chatId, message_id: messageId });
        return;
      }

      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။ PDF ဖန်တီးနေသည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      pdfPath = await createPdfFromImages(images);

      await bot.editMessageText(`⏳ PDF ပြုလုပ်ပြီ။ ပို့နေသည်...`, { chat_id: chatId, message_id: messageId });

      await bot.sendDocument(
        chatId,
        pdfPath,
        { caption: `📄 ${baseName}.pdf\n✅ ပုံ ${images.length} ပုံ ပါဝင်သည်` },
        { filename: `${baseName}.pdf`, contentType: "application/pdf" }
      );

      await bot.deleteMessage(chatId, messageId);
      logger.info({ chatId, fileName, imageCount: images.length }, "PDF sent");
    } catch (err) {
      logger.error({ err, chatId, fileName }, "PDF send error");
      bot.editMessageText(
        `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
        { chat_id: chatId, message_id: messageId }
      ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
    } finally {
      if (pdfPath && fs.existsSync(pdfPath)) { try { fs.unlinkSync(pdfPath); } catch { /* ignore */ } }
    }

  // ── Images ──
  } else if (action === "send_images") {
    await bot.editMessageText(`⏳ "${fileName}" ကို လုပ်ဆောင်နေသည်...`, {
      chat_id: chatId, message_id: messageId,
    });

    try {
      const images = await downloadAndExtract(fileId, fileName, chatId, messageId);

      if (images.length === 0) {
        await bot.editMessageText(`❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`, { chat_id: chatId, message_id: messageId });
        return;
      }

      const totalGroups = Math.ceil(images.length / 10);
      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။ ${totalGroups} အုပ်စုနဲ့ ပို့မည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      await sendImagesAsMediaGroups(chatId, images, baseName, messageId);

      await bot.deleteMessage(chatId, messageId);
      logger.info({ chatId, fileName, imageCount: images.length }, "Images sent as media groups");
    } catch (err) {
      logger.error({ err, chatId, fileName }, "Images send error");
      bot.editMessageText(
        `❌ အမှားဖြစ်သည်:\n${err instanceof Error ? err.message : String(err)}`,
        { chat_id: chatId, message_id: messageId }
      ).catch(() => bot.sendMessage(chatId, "❌ ဖိုင် လုပ်ဆောင်ရာ အမှားဖြစ်သည်။"));
    }
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

export { bot };
