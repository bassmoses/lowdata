import type { LowdataRequestError as LowdataRequestErrorShape } from '../core/types.js';

export class LowdataRequestError extends Error implements LowdataRequestErrorShape {
  status?: number;
  isNetworkError: boolean;
  isTimeout: boolean;
  attempt: number;
  retryAfterMs?: number;

  constructor(
    message: string,
    init: {
      status?: number;
      isNetworkError?: boolean;
      isTimeout?: boolean;
      attempt: number;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'LowdataRequestError';
    this.status = init.status;
    this.isNetworkError = init.isNetworkError ?? false;
    this.isTimeout = init.isTimeout ?? false;
    this.attempt = init.attempt;
    this.retryAfterMs = init.retryAfterMs;
  }
}
