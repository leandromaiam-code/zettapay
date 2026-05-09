export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const NotFound = (resource: string) =>
  new HttpError(404, 'not_found', `${resource} not found`);

export const Conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);

export const BadRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
