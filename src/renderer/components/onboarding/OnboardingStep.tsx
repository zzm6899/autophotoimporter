import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface OnboardingStepProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}

export function OnboardingStep({ eyebrow, title, description, icon: Icon, children }: OnboardingStepProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-text-secondary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{eyebrow}</div>
          <h2 className="mt-1 text-lg font-semibold leading-tight text-text">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
