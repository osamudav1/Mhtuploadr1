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
        const decoded = rawBody.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
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

// Convert images to PDF
async function createPdfFromImages(images: Buffer[]): Promise<string> {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `manga_${Date.now()}.pdf`);

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
      const writeStream = fs.createWriteStream(pdfPath);

      doc.pipe(writeStream);

      for (const imgBuffer of images) {
        // Get image dimensions
        const meta = await sharp(imgBuffer).metadata();
        const width = meta.width ?? 595;
        const height = meta.height ?? 842;

        // Convert to JPEG for PDF compatibility
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

// Handle /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `ဝမ်းကြောင်းပါတယ်! 📚\n\n` +
    `ဒီ bot က .mht ဖိုင်ထဲမှ manga ပုံတွေကို PDF အဖြစ်ပြောင်းပေးမှာပါ။\n\n` +
    `သုံးနည်း:\n` +
    `1. .mht ဖိုင်ကို ဒီ chat ထဲ ပို့လိုက်ပါ\n` +
    `2. Bot က ပုံတွေကို ထုတ်ယူပြီး PDF ပြုလုပ်ပေးမှာပါ\n` +
    `3. PDF ဖိုင်ကို ပြန်ရမှာပါ ✅`
  );
});

// Handle /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `📖 အသုံးပြုနည်း:\n\n` +
    `• .mht ဖိုင် (manga chapter) ကို ဤ bot ဆီ ပေးပို့ပါ\n` +
    `• Bot က ဖိုင်ထဲမှ ပုံများကို အစဉ်လိုက် ထုတ်ယူပါမည်\n` +
    `• ထို့နောက် PDF ဖိုင်အဖြစ် ပြောင်းပြီး ပြန်ပို့ပေးမည်\n\n` +
    `⚠️ မှတ်ချက်:\n` +
    `• ဖိုင်ကို Document အဖြစ် ပို့ပါ (Compression မဖြစ်ဘဲ)\n` +
    `• .mht format သာ လက်ခံသည်`
  );
});

// Handle document uploads
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const document = msg.document;

  if (!document) return;

  const fileName = document.file_name ?? "";
  const isMht = fileName.toLowerCase().endsWith(".mht") || 
                fileName.toLowerCase().endsWith(".mhtml") ||
                document.mime_type === "message/rfc822" ||
                document.mime_type === "multipart/related";

  if (!isMht) {
    bot.sendMessage(chatId, `❌ .mht သို့မဟုတ် .mhtml ဖိုင်သာ လက်ခံသည်။\nပေးပို့သော ဖိုင်: ${fileName}`);
    return;
  }

  const processingMsg = await bot.sendMessage(chatId, `⏳ ဖိုင် "${fileName}" ကို လုပ်ဆောင်နေသည်...\nပုံများ ထုတ်ယူနေသည်၊ ခဏစောင့်ပါ။`);

  let pdfPath: string | null = null;

  try {
    // Download the file from Telegram
    const fileLink = await bot.getFileLink(document.file_id);
    logger.info({ fileLink, fileName }, "Downloading .mht file");

    const response = await axios.get(fileLink, { responseType: "arraybuffer" });
    const mhtBuffer = Buffer.from(response.data);

    await bot.editMessageText(
      `⏳ ဖိုင် "${fileName}" ကို လုပ်ဆောင်နေသည်...\nပုံများ ရှာဖွေနေသည်...`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );

    // Extract images from .mht
    logger.info("Extracting images from .mht file");
    const images = await extractImagesFromMht(mhtBuffer);

    if (images.length === 0) {
      await bot.editMessageText(
        `❌ ဖိုင်ထဲတွင် ပုံများ မတွေ့ပါ။\nဖိုင်သည် .mht format မဟုတ်ဘဲ ဖြစ်နိုင်သည်။`,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );
      return;
    }

    await bot.editMessageText(
      `⏳ ပုံ ${images.length} ပုံ တွေ့ပြီ။\nPDF ဖန်တီးနေသည်...`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );

    // Create PDF
    logger.info({ imageCount: images.length }, "Creating PDF");
    pdfPath = await createPdfFromImages(images);

    await bot.editMessageText(
      `✅ PDF ဖန်တီးပြီး။ ပေးပို့နေသည်...`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );

    // Send the PDF
    const baseName = path.basename(fileName, path.extname(fileName));
    const pdfName = `${baseName}.pdf`;

    await bot.sendDocument(chatId, pdfPath, {
      caption: `📄 ${pdfName}\n✅ ပုံ ${images.length} ပုံ ပါဝင်သည်`,
    }, {
      filename: pdfName,
      contentType: "application/pdf",
    });

    await bot.deleteMessage(chatId, processingMsg.message_id);

    logger.info({ chatId, fileName, imageCount: images.length }, "PDF sent successfully");
  } catch (err) {
    logger.error({ err, chatId, fileName }, "Error processing .mht file");
    bot.editMessageText(
      `❌ အမှားတစ်ခု ဖြစ်ပေါ်သည်:\n${err instanceof Error ? err.message : "Unknown error"}\n\nထပ်မံ ကြိုးစားကြည့်ပါ။`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    ).catch(() => {
      bot.sendMessage(chatId, `❌ ဖိုင် လုပ်ဆောင်ရာတွင် အမှားဖြစ်သည်။ ထပ်မံ ကြိုးစားပါ။`);
    });
  } finally {
    // Clean up temp PDF file
    if (pdfPath && fs.existsSync(pdfPath)) {
      try {
        fs.unlinkSync(pdfPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
});

// Handle polling errors
bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

export { bot };
