import type { HostApi } from '@awesome-workflow/web-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const host = {} as HostApi;

afterEach(() => {
  vi.doUnmock('./runtime');
  vi.resetModules();
});

describe('federation remote mount lifecycle', () => {
  it('does not mount after unmount cancels a pending runtime load', async () => {
    const runtimeLoaded = deferred<void>();
    const mountControlPlane = vi.fn(async () => vi.fn());
    const unmountControlPlane = vi.fn();
    vi.doMock('./runtime', async () => {
      await runtimeLoaded.promise;
      return { mountControlPlane, unmountControlPlane };
    });
    const remote = await import('./remote');
    const container = {} as HTMLElement;

    const mounting = remote.mount(container, host);
    remote.unmount(container);
    runtimeLoaded.resolve();
    const cleanup = await mounting;

    expect(mountControlPlane).not.toHaveBeenCalled();
    expect(unmountControlPlane).not.toHaveBeenCalled();
    cleanup();
    expect(unmountControlPlane).not.toHaveBeenCalled();
  });

  it('cleans up a mount that resolves after its container was unmounted', async () => {
    const mountStarted = deferred<void>();
    const mountFinished = deferred<void>();
    const lateCleanup = vi.fn();
    const mountControlPlane = vi.fn(async () => {
      mountStarted.resolve();
      await mountFinished.promise;
      return lateCleanup;
    });
    const unmountControlPlane = vi.fn();
    vi.doMock('./runtime', () => ({ mountControlPlane, unmountControlPlane }));
    const remote = await import('./remote');
    const container = {} as HTMLElement;

    const mounting = remote.mount(container, host);
    await mountStarted.promise;
    remote.unmount(container);
    expect(unmountControlPlane).toHaveBeenCalledOnce();
    expect(unmountControlPlane).toHaveBeenCalledWith(container);

    mountFinished.resolve();
    const cleanup = await mounting;

    expect(lateCleanup).toHaveBeenCalledOnce();
    cleanup();
    expect(lateCleanup).toHaveBeenCalledOnce();
  });
});
