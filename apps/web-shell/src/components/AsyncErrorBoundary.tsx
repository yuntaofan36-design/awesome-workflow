import { Component, type ReactNode } from 'react';

import { useI18n } from '../i18n/I18nProvider';

type AsyncErrorBoundaryProps = {
  children: ReactNode;
  renderFallback: (options: { error: unknown; retry: () => void }) => ReactNode;
};

type AsyncErrorBoundaryState = {
  error: unknown;
  failed: boolean;
};

export class AsyncErrorBoundary extends Component<AsyncErrorBoundaryProps, AsyncErrorBoundaryState> {
  override state: AsyncErrorBoundaryState = { error: undefined, failed: false };

  static getDerivedStateFromError(error: unknown): AsyncErrorBoundaryState {
    return { error, failed: true };
  }

  private readonly retry = () => {
    this.setState({ error: undefined, failed: false });
  };

  override render() {
    if (this.state.failed) {
      return this.props.renderFallback({ error: this.state.error, retry: this.retry });
    }
    return this.props.children;
  }
}

export function LocalizedAsyncErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <AsyncErrorBoundary
      renderFallback={({ error, retry }) => (
        <AsyncErrorFallback
          body={t('asyncFailure.body')}
          detail={describeError(error, t('errors.unexpected'))}
          diagnosticsLabel={t('common.diagnostics')}
          eyebrow={t('asyncFailure.eyebrow')}
          onReload={() => window.location.reload()}
          onRetry={isAsyncModuleLoadError(error) ? undefined : retry}
          reloadLabel={t('asyncFailure.reload')}
          retryLabel={isAsyncModuleLoadError(error) ? undefined : t('asyncFailure.retry')}
          title={t('asyncFailure.title')}
        />
      )}
    >
      {children}
    </AsyncErrorBoundary>
  );
}

export function AsyncErrorFallback({
  body,
  detail,
  diagnosticsLabel,
  eyebrow,
  onReload,
  onRetry,
  reloadLabel,
  retryLabel,
  title,
}: {
  body: string;
  detail: string;
  diagnosticsLabel: string;
  eyebrow: string;
  onReload: () => void;
  onRetry?: () => void;
  reloadLabel: string;
  retryLabel?: string;
  title: string;
}) {
  return (
    <main className="async-failure" role="alert" aria-live="assertive">
      <section className="async-failure__panel">
        <span className="async-failure__eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{body}</p>
        <div className="async-failure__actions">
          <button className="async-failure__primary" type="button" onClick={onReload}>
            {reloadLabel}
          </button>
          {onRetry && retryLabel ? (
            <button className="async-failure__secondary" type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          ) : null}
        </div>
        <details>
          <summary>{diagnosticsLabel}</summary>
          <code>{detail}</code>
        </details>
      </section>
    </main>
  );
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function isAsyncModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /(?:dynamically imported module|importing a module script failed|loading chunk .+ failed|unable to preload css)/iu.test(
    error.message,
  );
}
