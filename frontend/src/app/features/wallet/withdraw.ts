import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { ConfigStore } from '../../core/config.store';
import { Wallet } from '../../core/models';
import { formatMoney } from '../../core/format';
import { MoneyPipe } from '../../shared/pipes';
import { DemoBadge } from '../../shared/ui';

@Component({
  selector: 'app-withdraw',
  imports: [FormsModule, RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, DemoBadge],
  template: `
    <div class="page page-narrow">
      <a class="back muted small" routerLink="/wallet"><mat-icon>arrow_back</mat-icon>Wallet</a>
      <div class="page-head"><div><h1>Demo Withdrawal</h1><p class="sub">Test the withdrawal flow with simulated funds.</p></div><app-demo-badge label="Demo mode" size="lg" /></div>
      <div class="demo-strip"><mat-icon>science</mat-icon> Demo withdrawal only. No real money will be transferred.</div>

      <div class="card panel">
        @if (success(); as s) {
          <div class="success fade-in">
            <div class="ok-icon"><mat-icon>check</mat-icon></div>
            <h2>Withdrawal: DEMO COMPLETED</h2>
            <p class="text-2"><strong class="money">{{ s.amount | money:'demo' }}</strong> was deducted from your demo wallet.</p>
            <p class="muted small">No real money was transferred. New available balance: <strong class="money">{{ s.wallet.available | money:'demo' }}</strong></p>
            <div class="row" style="justify-content:center;flex-wrap:wrap">
              <button class="btn" (click)="reset()">New withdrawal</button>
              <a class="btn" routerLink="/wallet/transactions">View transaction</a>
            </div>
          </div>
        } @else {
          <div class="row-between avail"><span class="muted">Available to withdraw</span><strong class="money">{{ available() | money:'demo' }}</strong></div>
          <label class="lbl" for="amt">Amount</label>
          <div class="custom">
            <span>P</span>
            <input id="amt" type="number" inputmode="decimal" min="1" step="0.01" [(ngModel)]="amount" placeholder="0.00" />
            <button class="btn btn-ghost btn-sm" type="button" (click)="amount = available()">Max</button>
          </div>
          <div class="quick">
            @for (q of [10, 50, 100]; track q) { <button type="button" class="btn btn-sm" (click)="amount = q" [disabled]="q > available()">{{ q | money }}</button> }
          </div>
          <label class="lbl">Destination</label>
          <div class="dest"><mat-icon>account_balance</mat-icon><div><strong>Demo payout account</strong><div class="muted tiny">Simulated: no bank, card or mobile-money provider is connected.</div></div></div>

          @if (error()) { <div class="form-error"><mat-icon>error</mat-icon>{{ error() }}</div> }
          <button class="btn btn-primary btn-lg btn-block" [disabled]="loading()" (click)="submit()">
            @if (loading()) { <mat-spinner diameter="20" /> } @else { Withdraw {{ (amount ?? 0) | money }} (demo) }
          </button>
          <p class="muted tiny center">Minimum {{ min() | money }}. Withdrawals are marked DEMO COMPLETED immediately. Locked stakes can't be withdrawn.</p>
        }
      </div>
    </div>
  `,
  styleUrl: './wallet-forms.scss',
})
export class WithdrawPage {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private configStore = inject(ConfigStore);
  protected available = computed(() => this.auth.wallet()?.available ?? 0);
  protected min = computed(() => this.configStore.config()?.minWithdrawal ?? 10);
  protected amount: number | null = null;
  protected loading = signal(false);
  protected error = signal('');
  protected success = signal<{ amount: number; wallet: Wallet } | null>(null);

  reset() { this.success.set(null); this.amount = null; }

  async submit() {
    const a = Number(this.amount);
    if (!this.amount || !Number.isFinite(a) || a <= 0) { this.error.set('Enter an amount greater than zero.'); return; }
    if (a < this.min()) { this.error.set(`The minimum demo withdrawal is ${formatMoney(this.min())}.`); return; }
    if (a > this.available()) { this.error.set(`Insufficient demo balance. Available: ${formatMoney(this.available())} DEMO.`); return; }
    this.loading.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ wallet: Wallet; amount: number }>('/wallet/demo-withdrawal', { amount: a });
      this.auth.wallet.set(r.wallet);
      this.success.set({ amount: r.amount, wallet: r.wallet });
    } catch (err) { this.error.set(apiError(err).message); } finally { this.loading.set(false); }
  }
}
