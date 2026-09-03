import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AsyncErrorBoundary, AsyncErrorFallback, isAsyncModuleLoadError } from './AsyncErrorBoundary';

describe('AsyncErrorFallback', () => {
  it('renders localized recovery actions and diagnostics', () => {
    const html = renderToStaticMarkup(
      <AsyncErrorFallback
        body="部署资源可能已更新。"
        detail="Failed to fetch dynamically imported module"
        diagnosticsLabel="技术详情"
        eyebrow="异步加载恢复"
        onReload={vi.fn()}
        onRetry={vi.fn()}
        reloadLabel="重新加载页面"
        retryLabel="重试渲染"
        title="页面组件加载失败"
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('页面组件加载失败');
    expect(html).toContain('重新加载页面');
    expect(html).toContain('重试渲染');
    expect(html).toContain('技术详情');
    expect(html).toContain('Failed to fetch dynamically imported module');
  });

  it('switches from its children to the recovery fallback after an error', () => {
    const error = new Error('chunk missing');
    const renderFallback = vi.fn(() => <span>recover the chunk</span>);
    const boundary = new AsyncErrorBoundary({
      children: <span>loaded content</span>,
      renderFallback,
    });

    expect(renderToStaticMarkup(boundary.render())).toContain('loaded content');
    boundary.state = AsyncErrorBoundary.getDerivedStateFromError(error);
    expect(renderToStaticMarkup(boundary.render())).toContain('recover the chunk');
    expect(renderFallback).toHaveBeenCalledWith({ error, retry: expect.any(Function) });
  });

  it('does not advertise an in-place retry for a cached lazy import failure', () => {
    expect(
      isAsyncModuleLoadError(
        new TypeError('Failed to fetch dynamically imported module: /assets/ShellLayout.js'),
      ),
    ).toBe(true);
    expect(isAsyncModuleLoadError(new Error('temporary render problem'))).toBe(false);

    const html = renderToStaticMarkup(
      <AsyncErrorFallback
        body="The deployment changed."
        detail="dynamic_module_load_failed"
        diagnosticsLabel="Diagnostics"
        eyebrow="Async recovery"
        onReload={vi.fn()}
        reloadLabel="Reload page"
        title="The component could not be loaded"
      />,
    );

    expect(html).toContain('Reload page');
    expect(html).not.toContain('Try rendering again');
  });
});
