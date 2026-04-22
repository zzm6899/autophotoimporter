import { useEffect, useState } from 'react';

interface HistogramProps {
  src?: string;
}

const histogramCache = new Map<string, number[]>();

export function Histogram({ src }: HistogramProps) {
  const [bins, setBins] = useState<number[]>([]);

  useEffect(() => {
    if (!src) {
      setBins([]);
      return;
    }
    const cached = histogramCache.get(src);
    if (cached) {
      setBins(cached);
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (cancelled) return;
      const canvas = document.createElement('canvas');
      const width = 96;
      const height = 64;
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
      const normalized = next.map((v) => v / max);
      histogramCache.set(src, normalized);
      if (histogramCache.size > 200) {
        const oldest = histogramCache.keys().next().value as string | undefined;
        if (oldest) histogramCache.delete(oldest);
      }
      setBins(normalized);
      };
      img.onerror = () => {
        if (!cancelled) setBins([]);
      };
      img.src = src;
    };
    const idle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(run, { timeout: 400 })
      : window.setTimeout(run, 80);
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idle);
      } else {
        window.clearTimeout(idle);
      }
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
