import { Component, Fragment, type ReactNode } from 'react';

import { useControlPlaneI18n } from '../i18n';

export type ControlPlaneRecoveryCopy = {
  diagnostics: string;
  dynamicBody: string;
  dynamicEyebrow: string;
  dynamicTitle: string;
  reload: string;
  remount: string;
  renderBody: string;
  renderEyebrow: string;
  renderTitle: string;
};

type BoundaryProps = {
  children: ReactNode;
  copy: ControlPlaneRecoveryCopy;
  onReload: () => void;
};

type BoundaryState = {
  error: unknown;
  failed: boolean;
  generation: number;
};

export class ControlPlaneErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined, failed: false, generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, failed: true };
  }

  private readonly remount = () => {
    this.setState((state) => ({ error: undefined, failed: false, generation: state.generation + 1 }));
  };

  override render() {
    if (this.state.failed) {
      const dynamicModuleFailure = isDynamicModuleLoadError(this.state.error);
      return (
        <ControlPlaneErrorFallback
          copy={this.props.copy}
          detail={describeError(this.state.error)}
          dynamicModuleFailure={dynamicModuleFailure}
          onReload={this.props.onReload}
          onRemount={dynamicModuleFailure ? undefined : this.remount}
        />
      );
    }

    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}

export function LocalizedControlPlaneErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useControlPlaneI18n();
  const copy: ControlPlaneRecoveryCopy = {
    diagnostics: t('recovery.diagnostics'),
    dynamicBody: t('recovery.dynamicBody'),
    dynamicEyebrow: t('recovery.dynamicEyebrow'),
    dynamicTitle: t('recovery.dynamicTitle'),
    reload: t('recovery.reload'),
    remount: t('recovery.remount'),
    renderBody: t('recovery.renderBody'),
    renderEyebrow: t('recovery.renderEyebrow'),
    renderTitle: t('recovery.renderTitle'),
  };

  return (
    <ControlPlaneErrorBoundary copy={copy} onReload={() => window.location.reload()}>
      {children}
    </ControlPlaneErrorBoundary>
  );
}

export function ControlPlaneErrorFallback({
  copy,
  detail,
  dynamicModuleFailure,
  onReload,
  onRemount,
}: {
  copy: ControlPlaneRecoveryCopy;
  detail: string;
  dynamicModuleFailure: boolean;
  onReload: () => void;
  onRemount?: () => void;
}) {
  return (
    <main className="cp-runtime-error" role="alert" aria-live="assertive">
      <section className="cp-runtime-error__panel">
        <span className="cp-runtime-error__eyebrow">
          {dynamicModuleFailure ? copy.dynamicEyebrow : copy.renderEyebrow}
        </span>
        <h1>{dynamicModuleFailure ? copy.dynamicTitle : copy.renderTitle}</h1>
        <p>{dynamicModuleFailure ? copy.dynamicBody : copy.renderBody}</p>
        <div className="cp-runtime-error__actions">
          {onRemount && (
            <button className="cp-runtime-error__primary" type="button" onClick={onRemount}>
              {copy.remount}
            </button>
          )}
          <button
            className={onRemount ? 'cp-runtime-error__secondary' : 'cp-runtime-error__primary'}
            type="button"
            onClick={onReload}
          >
            {copy.reload}
          </button>
        </div>
        <details>
          <summary>{copy.diagnostics}</summary>
          <code>{detail}</code>
        </details>
      </section>
    </main>
  );
}

export function isDynamicModuleLoadError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const fingerprint = [error.name, error.code, error.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return DYNAMIC_MODULE_ERROR_PATTERNS.some((pattern) => pattern.test(fingerprint));
}

const DYNAMIC_MODULE_ERROR_PATTERNS = [
  /chunkloaderror/iu,
  /(?:css_)?chunk_load_failed/iu,
  /loading (?:css )?chunk .* failed/iu,
  /failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /importing a module script failed/iu,
  /failed to load module script/iu,
  /unable to preload css/iu,
];

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
