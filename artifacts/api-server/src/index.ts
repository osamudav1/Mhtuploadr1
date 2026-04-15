import http from "http";
import { logger } from "./lib/logger";
import { initBot } from "./bot";

async function main() {
  // Optional HTTP health-check server (needed for Koyeb / cloud deployments).
  // If PORT is set, try to bind — but never crash the bot if it fails.
  const rawPort = process.env["PORT"];
  if (rawPort) {
    const port = Number(rawPort);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        logger.warn({ port }, "Port already in use — skipping HTTP server, bot will still run");
      } else {
        logger.warn({ err }, "HTTP server error — bot will still run");
      }
    });
    server.listen(port, () => {
      logger.info({ port }, "HTTP health-check server listening");
    });
  }

  // Start the Telegram bot — retry up to 3 times on failure
  let attempt = 0;
  while (attempt < 3) {
    try {
      await initBot();
      logger.info("Telegram bot is running");
      return;
    } catch (e) {
      attempt++;
      logger.error({ err: e, attempt }, "Failed to start Telegram bot — retrying in 5s");
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }

  logger.error("Could not start Telegram bot after 3 attempts — process will exit");
  process.exit(1);
}

main();
