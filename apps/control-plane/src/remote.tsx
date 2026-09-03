import type { HostApi, MicroAppModule } from '@awesome-workflow/web-sdk';

type RuntimeModule = typeof import('./runtime');
type PendingMount = {
  cancelled: boolean;
  cleanup?: () => void;
  generation: number;
  settle: () => void;
  settled: Promise<void>;
};

let runtime: RuntimeModule | undefined;
let runtimePromise: Promise<RuntimeModule> | undefined;
let nextGeneration = 0;
const pendingMounts = new WeakMap<HTMLElement, PendingMount>();

function loadRuntime(): Promise<RuntimeModule> {
  runtimePromise ??= import('./runtime')
    .then((module) => {
      runtime = module;
      return module;
    })
    .catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
  return runtimePromise;
}

export async function mount(container: HTMLElement, host: HostApi): Promise<() => void> {
  const previous = pendingMounts.get(container);
  if (previous) cancelMount(container, previous);

  const pending = createPendingMount(++nextGeneration);
  pendingMounts.set(container, pending);

  try {
    // Do not let a replacement mount overtake a cancelled runtime mount. Its
    // eventual cleanup must finish before the next generation touches the DOM.
    await previous?.settled;
    if (!isCurrentMount(container, pending)) return NOOP;

    const module = await loadRuntime();
    if (!isCurrentMount(container, pending)) return NOOP;

    const cleanup = await module.mountControlPlane(container, host);
    pending.cleanup = cleanup;
    if (!isCurrentMount(container, pending)) {
      cleanup();
      pending.cleanup = undefined;
      return NOOP;
    }

    return () => cancelMount(container, pending);
  } catch (error: unknown) {
    if (isCurrentMount(container, pending)) cancelMount(container, pending);
    throw error;
  } finally {
    pending.settle();
  }
}

export function unmount(container: HTMLElement): void {
  const pending = pendingMounts.get(container);
  if (!pending) return;
  cancelMount(container, pending);
}

function isCurrentMount(container: HTMLElement, pending: PendingMount): boolean {
  return !pending.cancelled && pendingMounts.get(container)?.generation === pending.generation;
}

function createPendingMount(generation: number): PendingMount {
  let settle: () => void = NOOP;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { cancelled: false, generation, settle, settled };
}

function cancelMount(container: HTMLElement, pending: PendingMount): void {
  if (!isCurrentMount(container, pending)) return;
  pending.cancelled = true;
  pendingMounts.delete(container);

  if (pending.cleanup) {
    const cleanup = pending.cleanup;
    pending.cleanup = undefined;
    cleanup();
    return;
  }

  // The runtime may already have mounted between its final await and resolving
  // mountControlPlane(). The late cleanup path above remains the final guard.
  runtime?.unmountControlPlane(container);
}

const NOOP = () => undefined;

const remoteModule = { mount, unmount } satisfies MicroAppModule;
export default remoteModule;
