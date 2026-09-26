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
      return { status: 0, code: 'NETWORK', message: 'Cannot reach the server. Check your connection (is the API running?) and try again.', fields: {} };
    }
    const body = err.error?.error;
    if (body?.message) {
      return { status: err.status, code: body.code || 'ERROR', message: body.message, fields: body.details?.fields || {} };
    }
    if (err.status === 504 || err.status === 502) {
      return { status: err.status, code: 'NETWORK', message: 'The server is not responding. Please try again shortly.', fields: {} };
    }
    return { status: err.status, code: 'ERROR', message: `Request failed (${err.status}). Please try again.`, fields: {} };
  }
  return { status: -1, code: 'ERROR', message: 'Something went wrong. Please try again.', fields: {} };
}
