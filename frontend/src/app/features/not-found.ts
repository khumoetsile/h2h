import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <div class="nf">
      <div class="code">404</div>
      <h1>Page not found</h1>
      <p class="muted">The page you're looking for doesn't exist or has moved.</p>
      <a class="btn btn-primary" [routerLink]="auth.isLoggedIn() ? auth.homeUrl() : '/login'">Go home</a>
    </div>
  `,
  styles: [`.nf { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 16px; }
    .code { font-family: var(--font-display); font-size: 88px; font-weight: 700; color: var(--accent); line-height: 1; }`],
})
export class NotFoundPage { protected auth = inject(AuthService); }
