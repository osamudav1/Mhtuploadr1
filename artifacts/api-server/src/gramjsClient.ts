import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { FloodWaitError } from "telegram/errors/index.js";
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
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        // gramjs will auto-sleep and retry FLOOD_WAIT up to this many seconds.
        // Waits beyond this threshold are re-thrown so we can handle them ourselves.
        floodSleepThreshold: 60,
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

/** Max seconds we'll wait for a single FLOOD_WAIT before giving up. */
const MAX_FLOOD_WAIT_SEC = 5 * 60; // 5 minutes
/** How many times to retry on FLOOD_WAIT / transient errors. */
const MAX_RETRIES = 4;

export async function downloadViaMtProto(
  chatId: number,
  messageId: number,
  onProgress?: (downloaded: number, total: number) => void
): Promise<Buffer | null> {
  const client = await getMtProtoClient();
  if (!client) return null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // gramjs accepts the raw chat ID from Bot API.
      // It handles PeerUser / PeerChat / PeerChannel internally.
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

    } catch (err: any) {
      // ── FLOOD_WAIT: gramjs throws this when wait > floodSleepThreshold ──────
      if (err instanceof FloodWaitError) {
        const waitSec = err.seconds ?? 60;
        if (waitSec > MAX_FLOOD_WAIT_SEC) {
          logger.error({ chatId, messageId, waitSec }, "MTProto FLOOD_WAIT too long — giving up");
          return null;
        }
        logger.warn({ chatId, messageId, waitSec, attempt }, `MTProto FLOOD_WAIT — sleeping ${waitSec}s`);
        await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
        continue; // retry
      }

      // ── Transient network errors — short backoff then retry ──────────────────
      const code: string = err?.code ?? err?.cause?.code ?? "";
      const isTransient =
        code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED" ||
        code === "EPIPE"      || code === "ENOTFOUND"  || code === "EAI_AGAIN" ||
        (err?.message ?? "").toLowerCase().includes("timeout");

      if (isTransient && attempt < MAX_RETRIES - 1) {
        const backoffMs = Math.min(3000 * Math.pow(2, attempt), 30_000);
        logger.warn({ chatId, messageId, code, attempt, backoffMs }, "MTProto transient error — retrying");
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      logger.error({ err, chatId, messageId, attempt }, "MTProto download failed");
      return null;
    }
  }

  logger.error({ chatId, messageId }, "MTProto download: exhausted retries");
  return null;
}
