export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const conflict = (code: string, message: string): never => {
  throw new DomainError(409, code, message);
};

export const notFound = (entity: string): never => {
  throw new DomainError(404, 'not_found', `${entity} was not found`);
};

export const forbidden = (message = 'This action is not allowed'): never => {
  throw new DomainError(403, 'forbidden', message);
};

export const invalidState = (message: string): never => {
  throw new DomainError(409, 'invalid_state', message);
};
