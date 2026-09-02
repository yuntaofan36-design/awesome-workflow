import type { PropsWithChildren, ReactNode } from 'react';

export type SignalTone = 'danger' | 'neutral' | 'success' | 'warning';

export function PlatformMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="aw-platform-mark" data-compact={compact || undefined}>
      <span className="aw-platform-mark__glyph" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span>
          <strong>Awesome</strong>
          <small>Workflow OS</small>
        </span>
      )}
    </div>
  );
}

export function SignalBadge({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: SignalTone }>) {
  return (
    <span className="aw-signal-badge" data-tone={tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

export function SectionIntro({
  action,
  eyebrow,
  title,
  description,
}: {
  action?: ReactNode;
  description?: ReactNode;
  eyebrow: string;
  title: ReactNode;
}) {
  return (
    <header className="aw-section-intro">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        {description && <div className="aw-section-intro__description">{description}</div>}
      </div>
      {action && <div className="aw-section-intro__action">{action}</div>}
    </header>
  );
}

export function MetricCard({ detail, label, value }: { detail: ReactNode; label: string; value: ReactNode }) {
  return (
    <article className="aw-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <div>{detail}</div>
    </article>
  );
}

export function StatePanel({ children, title }: PropsWithChildren<{ title: string }>) {
  return (
    <div className="aw-state-panel" role="status">
      <div className="aw-state-panel__radar" aria-hidden="true">
        <i />
      </div>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}
