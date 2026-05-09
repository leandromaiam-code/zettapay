import type { AxiosError } from 'axios';
import type { ApiErrorBody } from './types.js';

export class ZettaPayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly details?: unknown,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ZettaPayError';
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = (value as { error?: unknown }).error;
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as { code?: unknown }).code === 'string' &&
    typeof (candidate as { message?: unknown }).message === 'string'
  );
}

export function fromAxiosError(err: unknown): ZettaPayError {
  if (err instanceof ZettaPayError) return err;

  const axiosErr = err as AxiosError | undefined;
  if (axiosErr?.isAxiosError) {
    const status = axiosErr.response?.status;
    const body = axiosErr.response?.data;
    if (isApiErrorBody(body)) {
      return new ZettaPayError(body.error.message, body.error.code, status, body.error.details, err);
    }
    if (status !== undefined) {
      return new ZettaPayError(
        axiosErr.message || `request failed with status ${status}`,
        'http_error',
        status,
        body,
        err,
      );
    }
    return new ZettaPayError(
      axiosErr.message || 'network error',
      axiosErr.code ?? 'network_error',
      undefined,
      undefined,
      err,
    );
  }

  const message = err instanceof Error ? err.message : 'unknown error';
  return new ZettaPayError(message, 'unknown_error', undefined, undefined, err);
}
