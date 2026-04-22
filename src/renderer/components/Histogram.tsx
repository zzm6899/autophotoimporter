import { useEffect, useState } from 'react';

interface HistogramProps {
  src?: string;
}

export function Histogram({ src }: HistogramProps) {
  const [bins, setBins] = useState<number[]>([]);

  useEffect(() => {
    if (!src) {
      setBins([]);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement('canvas');
      const width = 160;
      const height = 100;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const next = Array.from({ length: 64 }, () => 0);
      for (let i = 0; i < data.length; i += 4) {
        const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        next[Math.min(63, Math.floor(luma / 4))]++;
      }
      const max = Math.max(1, ...next);
      setBins(next.map((v) => v / max));
    };
    img.onerror = () => {
      if (!cancelled) setBins([]);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (bins.length === 0) return null;

  return (
    <div className="absolute top-8 right-3 w-40 h-24 bg-black/55 border border-white/15 rounded-sm p-2 z-20 pointer-events-none">
      <svg viewBox="0 0 64 40" className="w-full h-full" preserveAspectRatio="none">
        <line x1="0" y1="0" x2="0" y2="40" stroke="rgba(255,255,255,0.22)" strokeWidth="0.5" />
        <line x1="63" y1="0" x2="63" y2="40" stroke="rgba(255,255,255,0.22)" strokeWidth="0.5" />
        {bins.map((v, i) => (
          <rect
            key={i}
            x={i}
            y={40 - v * 40}
            width="0.9"
            height={Math.max(0.4, v * 40)}
            fill="rgba(255,255,255,0.75)"
          />
        ))}
      </svg>
    </div>
  );
}
