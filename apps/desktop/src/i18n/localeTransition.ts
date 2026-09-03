export type LocaleTransitionQueue = {
  run: (transition: () => Promise<unknown>, commit: () => void) => Promise<boolean>;
};

export function createLocaleTransitionQueue(): LocaleTransitionQueue {
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async run(transition, commit) {
      const currentGeneration = ++generation;
      const current = queue.catch(() => undefined).then(transition);
      queue = current;
      await current;
      if (currentGeneration !== generation) return false;
      commit();
      return true;
    },
  };
}
