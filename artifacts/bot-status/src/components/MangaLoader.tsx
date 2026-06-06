import { useEffect, useState } from "react";

const FRAMES = ["/load1.jpg", "/load2.jpg", "/load3.jpg", "/load4.jpg"];
const FPS = 6;

interface MangaLoaderProps {
  size?: number;
  label?: string;
}

export function MangaLoader({ size = 120, label }: MangaLoaderProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "8px",
          overflow: "hidden",
          boxShadow: "0 0 0 2px rgba(125,211,252,0.25), 0 4px 24px rgba(0,0,0,0.5)",
          imageRendering: "pixelated",
        }}
      >
        {FRAMES.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            width={size}
            height={size}
            style={{
              display: "block",
              objectFit: "cover",
              position: i === 0 ? "relative" : "absolute",
              opacity: frame === i ? 1 : 0,
              transition: "opacity 0.05s",
              width: size,
              height: size,
            }}
          />
        ))}
      </div>
      {label && (
        <span style={{ color: "#94a3b8", fontSize: "0.85rem", letterSpacing: "0.05em" }}>
          {label}
        </span>
      )}
    </div>
  );
}

export function MangaSplash({ onDone }: { onDone: () => void }) {
  const [frame, setFrame] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const tick = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 1000 / FPS);
    const timer = setTimeout(() => {
      setFading(true);
      setTimeout(onDone, 600);
    }, 2200);
    return () => { clearInterval(tick); clearTimeout(timer); };
  }, [onDone]);

  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "#0f172a",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: "1.5rem", zIndex: 9999,
        opacity: fading ? 0 : 1,
        transition: "opacity 0.6s ease",
      }}
    >
      <div style={{ position: "relative", width: 180, height: 180 }}>
        {FRAMES.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            style={{
              position: "absolute", inset: 0,
              width: 180, height: 180,
              objectFit: "cover",
              borderRadius: "12px",
              boxShadow: "0 0 0 2px rgba(125,211,252,0.3), 0 8px 40px rgba(0,0,0,0.7)",
              opacity: frame === i ? 1 : 0,
              transition: "opacity 0.06s",
            }}
          />
        ))}
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{
          color: "#f1f5f9", fontSize: "1.1rem", fontWeight: 600,
          marginBottom: "0.35rem",
        }}>
          MHT → PDF Bot
        </div>
        <LoadingDots />
      </div>
    </div>
  );
}

function LoadingDots() {
  return (
    <span style={{ display: "inline-flex", gap: "5px", alignItems: "center" }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: 6, height: 6,
            borderRadius: "50%",
            background: "#7dd3fc",
            display: "inline-block",
            animation: `dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes dot-bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </span>
  );
}
