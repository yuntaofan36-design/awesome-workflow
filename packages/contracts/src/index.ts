export * from './auth.js';
export * from './catalog.js';
export * from './control-plane.js';
export * from './desktop.js';
export * from './jobs.js';
export * from './locale.js';
export * from './problem.js';
export * from './workspace.js';

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export type ApiSuccess<T> = {
  data: T;
};
