import { ApiErrorCode } from '@platform/shared';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: ApiErrorCode, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);

export const unauthorized = (code: ApiErrorCode = ApiErrorCode.AUTH_REQUIRED, message = 'Authentication required.') =>
  new HttpError(401, code, message);

export const forbidden = (
  code: ApiErrorCode = ApiErrorCode.FORBIDDEN,
  message = 'You do not have permission to perform this action.',
) => new HttpError(403, code, message);

export const notFound = (message = 'Not found.') => new HttpError(404, ApiErrorCode.NOT_FOUND, message);

export const paymentRequired = (message = 'Insufficient balance.', details?: unknown) =>
  new HttpError(402, ApiErrorCode.INSUFFICIENT_BALANCE, message, details);

export const conflict = (message = 'Conflict.', details?: unknown) =>
  new HttpError(409, ApiErrorCode.CONFLICT, message, details);

export const tooMany = (message = 'Too many requests.') =>
  new HttpError(429, ApiErrorCode.RATE_LIMITED, message);

export const internal = (message = 'Internal server error.') =>
  new HttpError(500, ApiErrorCode.INTERNAL, message);

export const serviceUnavailable = (message = 'Service unavailable.') =>
  new HttpError(503, ApiErrorCode.SERVICE_UNAVAILABLE, message);
