import { FolderOpen } from 'lucide-react';
import { useAppDispatch } from '../context/ImportContext';
import { useFileScanner } from '../hooks/useFileScanner';
import { BrandMark } from './BrandMark';

export function EmptyState() {
  const dispatch = useAppDispatch();
  const { startScan } = useFileScanner();

  const chooseFolder = async () => {
    const folder = await window.electronAPI.selectFolder('Choose a folder of photos to review');
    if (!folder) return;
    dispatch({ type: 'SET_SOURCE_KIND', kind: 'volume' });
    dispatch({ type: 'SELECT_SOURCE', path: folder });
    await startScan(folder);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <BrandMark className="h-14 w-14" />
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-text">Choose photos to review</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          Start with a folder now, or insert a camera card and choose it from the Source panel.
        </p>
      </div>
      <button
        type="button"
        onClick={() => { void chooseFolder(); }}
        className="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-hover"
      >
        <FolderOpen className="h-4 w-4" aria-hidden="true" />
        Choose photo folder
      </button>
      <p className="max-w-sm text-xs leading-relaxed text-text-muted">
        Keptra scans locally. Nothing is moved or copied until you review the import plan.
      </p>
    </div>
  );
}
