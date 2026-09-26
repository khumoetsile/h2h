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

  private show(message: string, panelClass: string, duration = 4000) {
    this.snack.open(message, 'OK', { duration, panelClass, horizontalPosition: 'center', verticalPosition: 'top' });
  }
}
