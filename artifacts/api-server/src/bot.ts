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

function decodeQuotedPrintable(input: string): Buffer {
  const decoded = input
    .replace(/=\r\n/g, "")
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(decoded, "binary");
}

async function extractImagesFromMht(mhtContent: Buffer): Promise<Buffer[]> {
  // Try UTF-8 first, fall back to latin1 (binary)
  const raw = mhtContent.toString("binary");

  // Find the boundary – it can appear as:
  //   boundary="some-string" or boundary=some-string (no quotes)
  const boundaryMatch = raw.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!boundaryMatch) throw new Error("MIME boundary not found in .mht file");
  const boundary = (boundaryMatch[1] ?? boundaryMatch[2]).trim();

  logger.info({ boundary }, "Parsed MIME boundary");

  // Split the file into MIME parts
  // Parts are delimited by "--boundary" (may have \r\n or \n)
  // We split on the literal delimiter line
  const delimiter = "--" + boundary;
  const parts = raw.split(new RegExp(delimiter + "(?:\r\n|\n|$)", "g"));

  logger.info({ totalParts: parts.length }, "Split into MIME parts");

  const images: Buffer[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.trim() === "--" || part.trim() === "") continue;

    // Separate headers from body at the first blank line
    const blankLineIdx = part.search(/\r?\n\r?\n/);
    if (blankLineIdx === -1) continue;

    const headerSection = part.slice(0, blankLineIdx);
    // Body is everything after the blank line; strip any trailing boundary/whitespace
    let body = part.slice(blankLineIdx).replace(/^\r?\n\r?\n/, "");

    // Remove trailing "--" or whitespace (end-of-part marker)
    body = body.replace(/\r?\n?--\s*$/, "").replace(/\s+$/, "");

    // Parse headers
    const headers: Record<string, string> = {};
    for (const line of headerSection.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }

    const contentType = headers["content-type"] ?? "";
    const isImage = /^image\//i.test(contentType);
    if (!isImage) continue;

    const mimeType = contentType.split(";")[0].trim().toLowerCase();
    const encoding = (headers["content-transfer-encoding"] ?? "base64").trim().toLowerCase();

    logger.info({ part: i, mimeType, encoding, bodyLen: body.length }, "Found image part");

    try {
      let imgBuffer: Buffer;

      if (encoding === "base64") {
        // Remove ALL whitespace (line breaks included) before decoding
        const cleanB64 = body.replace(/\s/g, "");
        if (cleanB64.length === 0) {
          logger.warn({ part: i }, "Empty base64 body, skipping");
          continue;
        }
        imgBuffer = Buffer.from(cleanB64, "base64");
      } else if (encoding === "quoted-printable") {
        imgBuffer = decodeQuotedPrintable(body);
      } else {
        // 8bit / binary / 7bit
        imgBuffer = Buffer.from(body, "binary");
      }

      if (imgBuffer.length < 100) {
        logger.warn({ part: i, size: imgBuffer.length }, "Image buffer too small, skipping");
        continue;
      }

      // Validate with sharp (non-strict: just check it doesn't throw)
      const meta = await sharp(imgBuffer).metadata();
      if (!meta.width || !meta.height) {
        logger.warn({ part: i }, "sharp: no dimensions, skipping");
        continue;
      }

      logger.info({ part: i, width: meta.width, height: meta.height }, "Valid image");
      images.push(imgBuffer);
    } catch (err) {
      logger.warn({ part: i, err }, "Failed to decode/validate image part, skipping");
    }
  }

  logger.info({ imageCount: images.length }, "Extraction complete");
  return images;
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
