import { useState, useCallback } from "react";
import { MangaSplash, MangaLoader } from "./components/MangaLoader";

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const done = useCallback(() => setLoaded(true), []);

  return (
    <>
      {!loaded && <MangaSplash onDone={done} />}

      <div style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
        color: "#f1f5f9",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        textAlign: "center",
        opacity: loaded ? 1 : 0,
        transition: "opacity 0.5s ease",
      }}>
        <div style={{ fontSize: "4rem", marginBottom: "1rem" }}>🤖</div>
        <h1 style={{ fontSize: "2rem", fontWeight: "700", marginBottom: "0.5rem" }}>
          MHT → PDF Telegram Bot
        </h1>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          background: "#14532d",
          color: "#86efac",
          padding: "0.5rem 1.2rem",
          borderRadius: "9999px",
          fontSize: "0.95rem",
          marginBottom: "2rem",
        }}>
          <span style={{
            width: "8px", height: "8px",
            borderRadius: "50%",
            background: "#4ade80",
            display: "inline-block",
            animation: "pulse-dot 2s ease-in-out infinite",
          }} />
          Bot Running
        </div>

        <p style={{ color: "#94a3b8", maxWidth: "420px", lineHeight: "1.7", marginBottom: "2rem" }}>
          .mht ဖိုင်ထဲမှ manga ပုံများကို <strong style={{ color: "#f1f5f9" }}>PDF</strong> သို့မဟုတ်
          <strong style={{ color: "#f1f5f9" }}> ပုံ group (10 ပုံစီ)</strong> အဖြစ် Telegram မှတဆင့် ပို့ပေးသည်။
        </p>

        <div style={{
          background: "#1e293b",
          borderRadius: "12px",
          padding: "1.5rem",
          maxWidth: "380px",
          width: "100%",
          textAlign: "left",
          marginBottom: "2.5rem",
        }}>
          <div style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Commands</div>
          {[
            ["/start", "ကြိုဆိုစာ ကြည့်ရန်"],
            ["/help", "အသုံးပြုနည်း"],
            [".mht file", "ဖိုင်ပေးပို့ → PDF သို့မဟုတ် ပုံ group ရွေး"],
          ].map(([cmd, desc]) => (
            <div key={cmd} style={{ display: "flex", gap: "1rem", marginBottom: "0.6rem", alignItems: "baseline" }}>
              <code style={{
                background: "#0f172a", color: "#7dd3fc",
                padding: "0.15rem 0.5rem", borderRadius: "4px",
                fontSize: "0.85rem", whiteSpace: "nowrap",
              }}>{cmd}</code>
              <span style={{ color: "#cbd5e1", fontSize: "0.9rem" }}>{desc}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
          <div style={{ color: "#475569", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>Processing</div>
          <MangaLoader size={80} label="ဖိုင် လုပ်ဆောင်နေသည်..." />
        </div>

        <style>{`
          @keyframes pulse-dot {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>
      </div>
    </>
  );
}
