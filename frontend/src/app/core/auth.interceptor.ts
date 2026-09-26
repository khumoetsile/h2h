import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.token();
  const authed = token && req.url.startsWith('/api') ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(authed).pipe(
    catchError((err: unknown) => {
      const isAuthCall = req.url.includes('/auth/login') || req.url.includes('/auth/register') || req.url.includes('/auth/logout');
      if (err instanceof HttpErrorResponse && !isAuthCall && token) {
        const code = err.error?.error?.code;
        // Expired/revoked session or disabled account -> back to login.
        if (err.status === 401 || (err.status === 403 && /disabled/i.test(err.error?.error?.message || '') && code === 'FORBIDDEN')) {
          auth.clear();
          router.navigate(['/login'], { queryParams: { reason: err.status === 401 ? 'expired' : 'disabled' } });
        }
      }
      return throwError(() => err);
    }),
  );
};
