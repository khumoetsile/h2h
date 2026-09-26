import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { apiError } from './api-error';

@Injectable({ providedIn: 'root' })
export class Toast {
  private snack = inject(MatSnackBar);

  success(message: string) { this.show(message, 'toast-success'); }
  info(message: string) { this.show(message, 'toast-info'); }
  error(messageOrErr: unknown) {
    const message = typeof messageOrErr === 'string' ? messageOrErr : apiError(messageOrErr).message;
    this.show(message, 'toast-error', 6000);
  }

  /** Clear any toast still on screen — used when entering a focused, distraction-free screen (gameplay, results). */
  dismiss() {
    // Deferred so this never runs in the same change-detection cycle as the
    // component that just requested it (avoids an ExpressionChangedAfter…
    // dev warning from the snack bar's own internal animation state).
    setTimeout(() => this.snack.dismiss());
  }

  private show(message: string, panelClass: string, duration = 4000) {
    this.snack.open(message, 'OK', { duration, panelClass, horizontalPosition: 'center', verticalPosition: 'top' });
  }
}
