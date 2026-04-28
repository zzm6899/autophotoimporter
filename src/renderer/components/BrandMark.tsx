interface BrandMarkProps {
  className?: string;
  title?: string;
}

export function BrandMark({ className = 'w-4 h-4', title = 'Keptra' }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 256 256" fill="none" role="img" aria-label={title}>
      <defs>
        <linearGradient id="keptra-react-mark-a" x1="58" y1="38" x2="218" y2="226" gradientUnits="userSpaceOnUse">
          <stop stopColor="#59DDB9" />
          <stop offset="0.52" stopColor="#37B69F" />
          <stop offset="1" stopColor="#1E6E92" />
        </linearGradient>
        <linearGradient id="keptra-react-mark-b" x1="70" y1="56" x2="202" y2="194" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0E1A1D" />
          <stop offset="1" stopColor="#142629" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="56" fill="#0D1416" />
      <rect x="13" y="13" width="230" height="230" rx="46" fill="url(#keptra-react-mark-b)" stroke="url(#keptra-react-mark-a)" strokeWidth="12" />
      <path d="M128 49L178 136H78L128 49Z" fill="url(#keptra-react-mark-a)" />
      <path d="M211 116L161 202L112 116H211Z" fill="#52D7B5" />
      <path d="M55 152L104 67L154 152H55Z" fill="#2585A1" />
      <path d="M88 139L121 173L190 92" stroke="#F6FBFA" strokeWidth="21" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M67 67H101M67 67V101M188 67H222M222 67V101M67 188V222H101M188 222H222V188" stroke="#F6FBFA" strokeOpacity="0.78" strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}
