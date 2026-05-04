import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'ghost';

const toneClasses: Record<Tone, string> = {
  neutral: 'border-border bg-surface-raised text-text-secondary hover:border-text-secondary hover:text-text hover:bg-border',
  primary: 'border-blue-500/30 bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 hover:text-blue-200',
  success: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 hover:text-emerald-200',
  warning: 'border-yellow-500/30 bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25 hover:text-yellow-200',
  danger: 'border-red-500/30 bg-red-500/15 text-red-300 hover:bg-red-500/25 hover:text-red-200',
  ghost: 'border-transparent bg-transparent text-text-muted hover:bg-surface-raised hover:text-text-secondary',
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  tone?: Tone;
  active?: boolean;
  size?: 'xs' | 'sm';
}

export function IconButton({
  icon: Icon,
  label,
  tone = 'ghost',
  active = false,
  size = 'sm',
  className = '',
  ...props
}: IconButtonProps) {
  const sizeClass = size === 'xs' ? 'h-6 w-6' : 'h-7 w-7';
  const iconClass = size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${sizeClass} inline-flex shrink-0 items-center justify-center rounded-md border text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'border-text-secondary bg-surface-raised text-text' : toneClasses[tone]
      } ${className}`}
      {...props}
    >
      <Icon className={iconClass} aria-hidden="true" />
    </button>
  );
}

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
}

export function ActionButton({ tone = 'neutral', icon: Icon, className = '', children, ...props }: ActionButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClasses[tone]} ${className}`}
      {...props}
    >
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

export function ToolbarGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`inline-flex shrink-0 items-center gap-px rounded-md border border-border bg-surface/70 p-0.5 ${className}`}>
      {children}
    </div>
  );
}

export function StatusPill({
  tone = 'neutral',
  children,
  title,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  icon: Icon,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {Icon && (
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface-alt text-text-muted">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">{eyebrow}</div>}
          <h3 className="text-xs font-semibold text-text">{title}</h3>
          {description && <p className="mt-0.5 text-[10px] leading-snug text-text-muted">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
