interface RecentDestinationsProps {
  destinations: string[];
  activeDestination: string | null;
  onSelect: (destination: string) => void;
  onChoose: () => void;
}

function labelForPath(value: string): string {
  return value.split(/[/\\]/).filter(Boolean).pop() ?? value;
}

export function RecentDestinations({ destinations, activeDestination, onSelect, onChoose }: RecentDestinationsProps) {
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onChoose}
        className="w-full rounded-md bg-surface-raised px-2 py-1.5 text-left text-xs text-text transition-colors hover:bg-border"
        aria-label={activeDestination ? `Change destination folder, currently ${activeDestination}` : 'Choose destination folder'}
      >
        {activeDestination ? labelForPath(activeDestination) : 'Choose destination folder'}
      </button>
      {destinations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {destinations.slice(0, 3).map((destination) => (
            <button
              key={destination}
              type="button"
              onClick={() => onSelect(destination)}
              className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                activeDestination === destination
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-border bg-surface text-text-muted hover:text-text-secondary'
              }`}
              title={destination}
            >
              {labelForPath(destination)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
