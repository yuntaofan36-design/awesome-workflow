import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneErrorFallback,
  isDynamicModuleLoadError,
  type ControlPlaneRecoveryCopy,
} from './ControlPlaneErrorBoundary';

const copy: ControlPlaneRecoveryCopy = {
  diagnostics: 'Technical details',
  dynamicBody: 'Reload to request the current assets.',
  dynamicEyebrow: 'RECOVERY / MODULE LOAD',
  dynamicTitle: 'Control Plane assets could not be loaded',
  reload: 'Reload page',
  remount: 'Remount application',
  renderBody: 'The isolated UI encountered an unexpected rendering error.',
  renderEyebrow: 'RECOVERY / RENDER',
  renderTitle: 'Control Plane stopped rendering',
};

describe('ControlPlaneErrorBoundary', () => {
  it.each([
    new TypeError('Failed to fetch dynamically imported module: https://cdn.example/page.js'),
    Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }),
    new Error('Importing a module script failed.'),
    Object.assign(new Error('stylesheet unavailable'), { code: 'CSS_CHUNK_LOAD_FAILED' }),
  ])('recognizes dynamic module failures', (error) => {
    expect(isDynamicModuleLoadError(error)).toBe(true);
  });

  it('does not classify an ordinary render exception as a module failure', () => {
    expect(isDynamicModuleLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('offers only a page reload after a dynamic module failure', () => {
    const html = renderToStaticMarkup(
      <ControlPlaneErrorFallback
        copy={copy}
        detail="Failed to fetch dynamically imported module"
        dynamicModuleFailure
        onReload={vi.fn()}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain(copy.dynamicTitle);
    expect(html).toContain(copy.reload);
    expect(html).not.toContain(copy.remount);
  });

  it('offers remount and reload actions after an ordinary render failure', () => {
    const html = renderToStaticMarkup(
      <ControlPlaneErrorFallback
        copy={copy}
        detail="Cannot read properties of undefined"
        dynamicModuleFailure={false}
        onReload={vi.fn()}
        onRemount={vi.fn()}
      />,
    );

    expect(html).toContain(copy.renderTitle);
    expect(html).toContain(copy.remount);
    expect(html).toContain(copy.reload);
    expect(html).toContain(copy.diagnostics);
  });
});
