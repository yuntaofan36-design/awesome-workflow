import type { HostEventMap, HostEventName, Unsubscribe } from '@awesome-workflow/web-sdk';

export type HostEventBus = ReturnType<typeof createHostEventBus>;

export function createHostEventBus() {
  const listeners = new Map<HostEventName, Set<(payload: never) => void>>();
  return {
    emit<TEvent extends HostEventName>(event: TEvent, payload: HostEventMap[TEvent]): void {
      listeners.get(event)?.forEach((listener) => listener(payload as never));
    },
    on<TEvent extends HostEventName>(
      event: TEvent,
      listener: (payload: HostEventMap[TEvent]) => void,
    ): Unsubscribe {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener as (payload: never) => void);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener as (payload: never) => void);
    },
  };
}
