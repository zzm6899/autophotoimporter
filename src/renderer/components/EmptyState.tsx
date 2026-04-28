import { BrandMark } from './BrandMark';

export function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 px-8">
      <BrandMark className="h-16 w-16" />
      <div className="text-center">
        <p className="text-sm text-text-secondary font-medium">Start with a camera card or folder</p>
        <p className="text-xs text-text-muted mt-1">
          Pick a source on the left. Then choose a destination on the right and press Import.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-[11px] text-text-muted max-w-lg">
        <div className="rounded border border-border bg-surface-alt px-3 py-2">
          <div className="font-mono text-emerald-400">1</div>
          Source
        </div>
        <div className="rounded border border-border bg-surface-alt px-3 py-2">
          <div className="font-mono text-blue-400">2</div>
          Review
        </div>
        <div className="rounded border border-border bg-surface-alt px-3 py-2">
          <div className="font-mono text-yellow-400">3</div>
          Import
        </div>
      </div>
    </div>
  );
}
