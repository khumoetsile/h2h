import { HttpErrorResponse } from '@angular/common/http';

export interface ApiErrorInfo {
  status: number;
  code: string;
  message: string;
  fields: Record<string, string>;
}

/** Turn any HTTP failure into a user-facing message. */
export function apiError(err: unknown): ApiErrorInfo {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return { status: 0, code: 'NETWORK', message: 'We could not connect. Check your internet connection and try again.', fields: {} };
    }
    const body = err.error?.error;
    if (body?.message) {
      return { status: err.status, code: body.code || 'ERROR', message: body.message, fields: body.details?.fields || {} };
    }
    if (err.status === 504 || err.status === 502) {
      return { status: err.status, code: 'NETWORK', message: 'The server is not responding. Please try again shortly.', fields: {} };
    }
    return { status: err.status, code: 'ERROR', message: err.status >= 500 ? 'This service is temporarily unavailable. Please try again shortly.' : 'We could not complete your request. Please try again.', fields: {} };
  }
  return { status: -1, code: 'ERROR', message: 'Something went wrong. Please try again.', fields: {} };
}
