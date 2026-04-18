import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = "6762363593";
const BASE = "http://127.0.0.1:8787";

const dir = path.join(os.tmpdir(), `test_${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

// Create 3 small test JPEG images with sharp
const files = [];
for (let i = 0; i < 3; i++) {
  const buf = await sharp({
    create: { width: 400, height: 600, channels: 3, background: { r: 100 + i*30, g: 50, b: 200 } }
  }).jpeg().toBuffer();
  const name = `poto ${i+1} - Fated5 - [ Manhwa by Luna ].jpg`;
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, buf);
  files.push({ fp, name });
}

const form = new FormData();
form.append("chat_id", CHAT_ID);

const media = files.map((f, i) => ({
  type: "document",
  media: `attach://${i}`,
}));
form.append("media", JSON.stringify(media));

files.forEach((f, i) => {
  form.append(String(i), fs.createReadStream(f.fp), {
    filename: f.name,
    contentType: "image/jpeg",
  });
});

try {
  const res = await axios.post(
    `${BASE}/bot${TOKEN}/sendMediaGroup`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity }
  );
  console.log("OK:", res.data);
} catch (e) {
  console.log("ERR:", e.response?.status, JSON.stringify(e.response?.data));
}

files.forEach(f => fs.unlinkSync(f.fp));
fs.rmdirSync(dir);
