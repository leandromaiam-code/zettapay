import { describe, expect, it } from 'vitest';
import type { AxiosError } from 'axios';
import { ZettaPayError, fromAxiosError } from '../src/errors.js';

function buildAxiosError(overrides: Partial<AxiosError> & {
  response?: { status?: number; data?: unknown };
} = {}): AxiosError {
  const err = new Error(overrides.message ?? 'axios failure') as AxiosError;
  (err as AxiosError).isAxiosError = true;
  if (overrides.response) {
    (err as AxiosError).response = overrides.response as AxiosError['response'];
  }
  if (overrides.code !== undefined) {
    (err as AxiosError).code = overrides.code;
  }
  return err;
}

describe('ZettaPayError', () => {
  it('exposes message, code, status, details and cause', () => {
    const cause = new Error('root cause');
    const details = { field: 'amount', reason: 'too_small' };
    const err = new ZettaPayError('boom', 'test_error', 422, details, cause);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ZettaPayError);
    expect(err.message).toBe('boom');
    expect(err.code).toBe('test_error');
    expect(err.status).toBe(422);
    expect(err.details).toEqual(details);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('ZettaPayError');
  });

  it('defaults status, details and cause to undefined', () => {
    const err = new ZettaPayError('partial', 'partial_error');
    expect(err.status).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('preserves stack trace from Error', () => {
    const err = new ZettaPayError('with stack', 'stack_error');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('ZettaPayError');
  });
});

describe('fromAxiosError', () => {
  it('returns the same instance when input is already a ZettaPayError', () => {
    const original = new ZettaPayError('passthrough', 'already_wrapped', 400);
    const result = fromAxiosError(original);
    expect(result).toBe(original);
  });

  describe('axios errors with structured ApiErrorBody', () => {
    it('extracts code, message, status and details from API response', () => {
      const details = { fields: ['walletPubkey'] };
      const axiosErr = buildAxiosError({
        response: {
          status: 422,
          data: {
            error: {
              code: 'validation_error',
              message: 'walletPubkey is required',
              details,
            },
          },
        },
      });

      const result = fromAxiosError(axiosErr);

      expect(result).toBeInstanceOf(ZettaPayError);
      expect(result.code).toBe('validation_error');
      expect(result.message).toBe('walletPubkey is required');
      expect(result.status).toBe(422);
      expect(result.details).toEqual(details);
      expect(result.cause).toBe(axiosErr);
    });

    it('handles API error body without details', () => {
      const axiosErr = buildAxiosError({
        response: {
          status: 404,
          data: {
            error: {
              code: 'not_found',
              message: 'merchant not found',
            },
          },
        },
      });

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('not_found');
      expect(result.message).toBe('merchant not found');
      expect(result.status).toBe(404);
      expect(result.details).toBeUndefined();
    });
  });

  describe('axios errors without structured ApiErrorBody (http_error)', () => {
    it('falls back to http_error when status is present but body is not API-shaped', () => {
      const axiosErr = buildAxiosError({
        message: 'Request failed with status code 500',
        response: { status: 500, data: '<html>oops</html>' },
      });

      const result = fromAxiosError(axiosErr);

      expect(result.code).toBe('http_error');
      expect(result.message).toBe('Request failed with status code 500');
      expect(result.status).toBe(500);
      expect(result.details).toBe('<html>oops</html>');
      expect(result.cause).toBe(axiosErr);
    });

    it('synthesizes a default message when axios message is empty', () => {
      const axiosErr = buildAxiosError({
        message: '',
        response: { status: 502, data: null },
      });
      // build helper sets message via Error constructor; force empty
      (axiosErr as Error).message = '';

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('http_error');
      expect(result.message).toBe('request failed with status 502');
      expect(result.status).toBe(502);
    });

    it('treats partial error bodies (missing code) as http_error', () => {
      const axiosErr = buildAxiosError({
        response: {
          status: 400,
          data: { error: { message: 'no code field' } },
        },
      });

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('http_error');
      expect(result.status).toBe(400);
    });

    it('treats partial error bodies (missing message) as http_error', () => {
      const axiosErr = buildAxiosError({
        response: {
          status: 400,
          data: { error: { code: 'no_message_field' } },
        },
      });

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('http_error');
      expect(result.status).toBe(400);
    });
  });

  describe('axios errors without a response (network errors)', () => {
    it('uses axios error code when present', () => {
      const axiosErr = buildAxiosError({
        message: 'connect ECONNREFUSED 127.0.0.1:80',
        code: 'ECONNREFUSED',
      });

      const result = fromAxiosError(axiosErr);

      expect(result.code).toBe('ECONNREFUSED');
      expect(result.message).toBe('connect ECONNREFUSED 127.0.0.1:80');
      expect(result.status).toBeUndefined();
      expect(result.details).toBeUndefined();
      expect(result.cause).toBe(axiosErr);
    });

    it('defaults to network_error code when axios code is missing', () => {
      const axiosErr = buildAxiosError({ message: 'socket hang up' });

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('network_error');
      expect(result.message).toBe('socket hang up');
      expect(result.status).toBeUndefined();
    });

    it('synthesizes a default message when axios message is empty', () => {
      const axiosErr = buildAxiosError({ code: 'ETIMEDOUT' });
      (axiosErr as Error).message = '';

      const result = fromAxiosError(axiosErr);
      expect(result.code).toBe('ETIMEDOUT');
      expect(result.message).toBe('network error');
    });
  });

  describe('non-axios errors', () => {
    it('wraps a standard Error as unknown_error', () => {
      const native = new Error('something else broke');

      const result = fromAxiosError(native);

      expect(result).toBeInstanceOf(ZettaPayError);
      expect(result.code).toBe('unknown_error');
      expect(result.message).toBe('something else broke');
      expect(result.status).toBeUndefined();
      expect(result.cause).toBe(native);
    });

    it('wraps a non-Error value as unknown_error with default message', () => {
      const result = fromAxiosError('plain string thrown');

      expect(result).toBeInstanceOf(ZettaPayError);
      expect(result.code).toBe('unknown_error');
      expect(result.message).toBe('unknown error');
      expect(result.cause).toBe('plain string thrown');
    });

    it('wraps undefined as unknown_error', () => {
      const result = fromAxiosError(undefined);
      expect(result.code).toBe('unknown_error');
      expect(result.message).toBe('unknown error');
      expect(result.cause).toBeUndefined();
    });

    it('wraps null as unknown_error', () => {
      const result = fromAxiosError(null);
      expect(result.code).toBe('unknown_error');
      expect(result.message).toBe('unknown error');
      expect(result.cause).toBeNull();
    });

    it('ignores objects that merely look axios-shaped without isAxiosError', () => {
      const fake = {
        response: { status: 500, data: { error: { code: 'x', message: 'y' } } },
        message: 'fake',
      };

      const result = fromAxiosError(fake);
      expect(result.code).toBe('unknown_error');
      expect(result.message).toBe('unknown error');
    });
  });
});
