import TelegramBot from "node-telegram-bot-api";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "./lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
}

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

// Clean up pending files older than 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles.entries()) {
    if (now - file.timestamp > 10 * 60 * 1000) {
      pendingFiles.delete(chatId);
    }
  }
}, 60 * 1000);

// Parse .mht file and extract images in order
async function extractImagesFromMht(mhtContent: Buffer): Promise<Buffer[]> {
  const content = mhtContent.toString("binary");

  // Find MIME boundary from Content-Type header
  const boundaryMatch = content.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) {
    throw new Error("MIME boundary not found in .mht file");
  }
  const boundary = boundaryMatch[1];

  // Split by boundary
  const parts = content.split("--" + boundary);

  const images: Buffer[] = [];

  for (const part of parts) {
    // Check if this part is an image
    const contentTypeMatch = part.match(/Content-Type:\s*(image\/[^\r\n;]+)/i);
    if (!contentTypeMatch) continue;

    const mimeType = contentTypeMatch[1].trim().toLowerCase();
    if (!["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"].includes(mimeType)) continue;

    // Get transfer encoding
    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : "base64";

    // Extract the body (after the blank line separating headers from body)
    const bodyMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
    if (!bodyMatch) continue;

    const rawBody = bodyMatch[1].replace(/\r?\n--.*$/s, "").trim();

    try {
      let imageBuffer: Buffer;
      if (encoding === "base64") {
        const cleanBase64 = rawBody.replace(/\s+/g, "");
        imageBuffer = Buffer.from(cleanBase64, "base64");
      } else if (encoding === "quoted-printable") {
        const decoded = rawBody
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        imageBuffer = Buffer.from(decoded, "binary");
      } else {
        imageBuffer = Buffer.from(rawBody, "binary");
      }

      // Validate image by trying to get metadata with sharp
      const metadata = await sharp(imageBuffer).metadata();
      if (metadata.width && metadata.height) {
        images.push(imageBuffer);
      }
    } catch {
      // Skip invalid images
    }
  }

  return images;
}

// Convert images to PDF and return path
async function createPdfFromImages(images: Buffer[]): Promise<string> {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `manga_${Date.now()}.pdf`);

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
      const writeStream = fs.createWriteStream(pdfPath);

      doc.pipe(writeStream);

      for (const imgBuffer of images) {
        const meta = await sharp(imgBuffer).metadata();
        const width = meta.width ?? 595;
        const height = meta.height ?? 842;
        const jpegBuffer = await sharp(imgBuffer).jpeg({ quality: 90 }).toBuffer();

        doc.addPage({ size: [width, height] });
        doc.image(jpegBuffer, 0, 0, { width, height });
      }

      doc.end();
      writeStream.on("finish", () => resolve(pdfPath));
      writeStream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Send images as media groups (10 per group)
async function sendImagesAsMediaGroups(
  chatId: number,
  images: Buffer[],
  baseName: string
): Promise<void> {
  const tmpDir = os.tmpdir();
  const tempFiles: string[] = [];

  try {
    // Save all images as temp JPEG files
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(tmpDir, `img_${Date.now()}_${i}.jpg`);
      await sharp(images[i]).jpeg({ quality: 92 }).toFile(imgPath);
      tempFiles.push(imgPath);
    }

    // Send in groups of 10
    const groupSize = 10;
    const totalGroups = Math.ceil(images.length / groupSize);

    for (let g = 0; g < totalGroups; g++) {
      const start = g * groupSize;
      const end = Math.min(start + groupSize, images.length);
      const groupFiles = tempFiles.slice(start, end);

      const media = groupFiles.map((filePath, idx) => ({
        type: "photo" as const,
        media: fs.createReadStream(filePath),
        caption:
          g === 0 && idx === 0
            ? `📚 ${baseName}\nပုံ ${images.length} ပုံ (အုပ်စု ${totalGroups} ခု)`
            : undefined,
      }));

      await bot.sendMediaGroup(chatId, media);

      // Small delay between groups to avoid flood limits
      if (g < totalGroups - 1) {
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  } finally {
    // Clean up temp files
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }
}

// Download .mht file and extract images
async function downloadAndExtract(
  fileId: string,
  fileName: string,
  chatId: number,
  statusMsgId: number
): Promise<Buffer[]> {
  const fileLink = await bot.getFileLink(fileId);
  logger.info({ fileLink, fileName }, "Downloading .mht file");

  const response = await axios.get(fileLink, { responseType: "arraybuffer" });
  const mhtBuffer = Buffer.from(response.data);

  await bot.editMessageText(
    `⏳ "${fileName}"\nပုံများ ရှာဖွေနေသည်...`,
    { chat_id: chatId, message_id: statusMsgId }
  );

  const images = await extractImagesFromMht(mhtBuffer);
  return images;
}

// ─── Commands ───────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `မင်္ဂလာပါ! 📚\n\n` +
      `.mht ဖိုင် (manga chapter) ကို ဒီ chat ထဲ Document အဖြစ် ပို့လိုက်ပါ။\n\n` +
      `Bot က ပုံ‌တွေ ထုတ်ပြီး:\n` +
      `• 📄 PDF အဖြစ် ပြောင်းပြီး ပို့\n` +
      `• 🖼 ပုံများ တိုက်ရိုက် (10 ပုံစီ) ပို့\n\n` +
      `ဆိုတဲ့ နည်းနှစ်မျိုးထဲ သင်ရွေးချယ်နိုင်သည်။`
  );
});

bot.onText(/\/help/, (msg) => {
  if (!isOwner(msg.from?.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `📖 အသုံးပြုနည်း:\n\n` +
      `1. .mht ဖိုင်ကို Document အဖြစ် (ဖိုင်တိုက်ရိုက်) ပို့ပါ\n` +
      `2. Bot က ပုံ‌တွေ ထုတ်ပြီး နည်း ၂ မျိုး offer ပေးမည်\n` +
      `3. သင်ကြိုက်သည့် နည်းကို ရွေးပါ\n\n` +
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
    bot.sendMessage(
      chatId,
      `❌ .mht သို့မဟုတ် .mhtml ဖိုင်သာ လက်ခံသည်။\nပေးပို့သော ဖိုင်: ${fileName}`
    );
    return;
  }

  // Store pending file
  pendingFiles.set(chatId, {
    fileId: document.file_id,
    fileName,
    timestamp: Date.now(),
  });

  // Ask user to choose delivery method
  await bot.sendMessage(
    chatId,
    `📂 "${fileName}" လက်ခံရပြီ!\n\nပုံများကို မည်သို့ ပို့ပေးရမလဲ?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📄 PDF အဖြစ် ပြောင်းပြီး ပို့",
              callback_data: "send_pdf",
            },
          ],
          [
            {
              text: "🖼 ပုံများ တိုက်ရိုက် ပို့ (10 ပုံစီ)",
              callback_data: "send_images",
            },
          ],
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

  const action = query.data;
  const pending = pendingFiles.get(chatId);

  // Answer the callback to remove loading state on button
  await bot.answerCallbackQuery(query.id);

  if (!pending) {
    await bot.editMessageText(
      `⚠️ ဖိုင် မတွေ့ပါ။ ဖိုင်ကို ထပ်မံ ပို့ပြီး ကြိုးစားပါ။`,
      { chat_id: chatId, message_id: messageId }
    );
    return;
  }

  pendingFiles.delete(chatId);
  const { fileId, fileName } = pending;
  const baseName = path.basename(fileName, path.extname(fileName));

  if (action === "send_pdf") {
    // Remove inline keyboard
    await bot.editMessageText(
      `⏳ "${fileName}"\nဒေါင်းလုပ် ဆွဲနေသည်...`,
      { chat_id: chatId, message_id: messageId }
    );

    let pdfPath: string | null = null;
    try {
      const images = await downloadAndExtract(fileId, fileName, chatId, messageId);

      if (images.length === 0) {
        await bot.editMessageText(
          `❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`,
          { chat_id: chatId, message_id: messageId }
        );
        return;
      }

      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။\nPDF ဖန်တီးနေသည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      pdfPath = await createPdfFromImages(images);

      await bot.editMessageText(
        `⏳ PDF ပြုလုပ်ပြီ။ ပို့နေသည်...`,
        { chat_id: chatId, message_id: messageId }
      );

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
      if (pdfPath && fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(pdfPath); } catch { /* ignore */ }
      }
    }
  } else if (action === "send_images") {
    await bot.editMessageText(
      `⏳ "${fileName}"\nဒေါင်းလုပ် ဆွဲနေသည်...`,
      { chat_id: chatId, message_id: messageId }
    );

    try {
      const images = await downloadAndExtract(fileId, fileName, chatId, messageId);

      if (images.length === 0) {
        await bot.editMessageText(
          `❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။`,
          { chat_id: chatId, message_id: messageId }
        );
        return;
      }

      const totalGroups = Math.ceil(images.length / 10);
      await bot.editMessageText(
        `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။\nအုပ်စု ${totalGroups} ခုနဲ့ ပို့နေသည်...`,
        { chat_id: chatId, message_id: messageId }
      );

      await sendImagesAsMediaGroups(chatId, images, baseName);

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

// Handle polling errors
bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

export { bot };
