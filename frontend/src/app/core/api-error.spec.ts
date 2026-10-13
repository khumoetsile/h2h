import { HttpErrorResponse } from '@angular/common/http';
import { apiError } from './api-error';

describe('apiError', () => {
  it('explains connection failures without asking players to troubleshoot the API', () => {
    const error = apiError(new HttpErrorResponse({ status: 0 }));
    expect(error.code).toBe('NETWORK');
    expect(error.message).toBe('We could not connect. Check your internet connection and try again.');
  });

  it('gives a recovery instruction for an unavailable service without exposing HTTP codes', () => {
    const error = apiError(new HttpErrorResponse({ status: 500, error: 'Proxy error' }));
    expect(error.status).toBe(500);
    expect(error.message).toBe('This service is temporarily unavailable. Please try again shortly.');
  });

  it('preserves actionable server validation messages and field details', () => {
    const error = apiError(new HttpErrorResponse({
      status: 422,
      error: { error: { code: 'VALIDATION', message: 'Check your details.', details: { fields: { email: 'Enter a valid email.' } } } },
    }));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toBe('Check your details.');
    expect(error.fields).toEqual({ email: 'Enter a valid email.' });
  });
});
