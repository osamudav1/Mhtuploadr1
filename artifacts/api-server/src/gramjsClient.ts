import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { logger } from "./lib/logger.js";

const apiId   = process.env["TELEGRAM_API_ID"];
const apiHash = process.env["TELEGRAM_API_HASH"];
const botToken = process.env["TELEGRAM_BOT_TOKEN"];

export function isMtProtoAvailable(): boolean {
  return !!(apiId && apiHash && botToken);
}

let _client: TelegramClient | null = null;
let _ready = false;
let _initPromise: Promise<TelegramClient | null> | null = null;

async function initClient(): Promise<TelegramClient | null> {
  if (!isMtProtoAvailable()) return null;

  try {
    const client = new TelegramClient(
      new StringSession(""),
      parseInt(apiId!),
      apiHash!,
      {
        connectionRetries: 3,
        retryDelay: 1000,
        autoReconnect: true,
      }
    );

    await client.start({ botAuthToken: botToken! });
    logger.info("MTProto client connected — large file download active");
    return client;
  } catch (err) {
    logger.error({ err }, "MTProto client connection failed");
    return null;
  }
}

export async function getMtProtoClient(): Promise<TelegramClient | null> {
  if (_ready && _client) return _client;

  if (!_initPromise) {
    _initPromise = initClient().then((c) => {
      _client = c;
      _ready = c !== null;
      return c;
    });
  }

  return _initPromise;
}

export async function downloadViaMtProto(
  chatId: number,
  messageId: number,
  onProgress?: (downloaded: number, total: number) => void
): Promise<Buffer | null> {
  const client = await getMtProtoClient();
  if (!client) return null;

  try {
    // gramjs accepts the raw chat ID from Bot API
    // It handles PeerUser / PeerChat / PeerChannel internally
    const messages = await client.getMessages(chatId, { ids: [messageId] });
    const msg = messages[0];

    if (!msg?.media) {
      logger.warn({ chatId, messageId }, "MTProto: message not found or no media");
      return null;
    }

    const data = await client.downloadMedia(msg.media, {
      progressCallback: onProgress
        ? (downloaded: bigint, total: bigint) =>
            onProgress(Number(downloaded), Number(total))
        : undefined,
    });

    if (!data) return null;
    return Buffer.from(data as Uint8Array);
  } catch (err) {
    logger.error({ err, chatId, messageId }, "MTProto download failed");
    return null;
  }
}
