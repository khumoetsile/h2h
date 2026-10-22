import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

export function normalizeChallengeCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^(?:M|H2H)-[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}
@Component({
  selector: 'app-challenge-entry', imports: [FormsModule],
  template: `<form class="card entry" (ngSubmit)="open()"><label for="challenge-code">Have a challenge code?</label><div><input id="challenge-code" name="code" [(ngModel)]="code" maxlength="12" autocomplete="off" autocapitalize="characters" placeholder="H2H-XXXXXXXX" required/><button class="btn btn-primary" type="submit">Review challenge</button></div><p class="muted small">Review the opponent and demo stake before joining.</p>@if(error()) { <p class="form-error" role="alert">{{ error() }}</p> }</form>`,
  styles: [`.entry { margin-bottom:16px; display:flex; flex-direction:column; gap:8px; } .entry div {display:flex; flex-wrap:wrap; gap:8px;} input { min-width:0; flex:1; padding:12px; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:8px; }`],
})
export class ChallengeEntry {
  private router = inject(Router);
  protected code = '';
  protected error = signal('');
  protected open() {
    const code = normalizeChallengeCode(this.code);
    if (!code) { this.error.set('Enter a complete code such as H2H-ABCDEFGH.'); return; }
    this.error.set(''); void this.router.navigate(['/join', code]);
  }
}
