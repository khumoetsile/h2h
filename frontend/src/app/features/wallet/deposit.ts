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
  selector: 'app-deposit',
  imports: [FormsModule, RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, DemoBadge],
  template: `
    <div class="page page-narrow">
      <a class="back muted small" routerLink="/wallet"><mat-icon>arrow_back</mat-icon>Wallet</a>
      <div class="page-head"><div><h1>Add Demo Funds</h1><p class="sub">Top up your demo wallet instantly.</p></div><app-demo-badge label="Demo mode" size="lg" /></div>
      <div class="demo-strip"><mat-icon>science</mat-icon> DEMO MODE: No real money is being deposited</div>

      <div class="card panel">
        @if (success(); as s) {
          <div class="success fade-in">
            <div class="ok-icon"><mat-icon>check</mat-icon></div>
            <h2>Demo deposit successful</h2>
            <p class="text-2"><strong class="money">{{ s.amount | money:'demo' }}</strong> was added to your demo wallet.</p>
            <p class="muted small">New available balance: <strong class="money">{{ s.wallet.available | money:'demo' }}</strong></p>
            <div class="row" style="justify-content:center;flex-wrap:wrap">
              <button class="btn" (click)="reset()">Add more</button>
              <a class="btn" routerLink="/wallet/transactions">View transaction</a>
              <a class="btn btn-primary" routerLink="/games">Play now</a>
            </div>
          </div>
        } @else {
          <label class="lbl">Choose an amount</label>
          <div class="tiles">
            @for (p of presets(); track p) {
              <button type="button" class="tile" [class.selected]="amount() === p && !custom" (click)="choose(p)">{{ p | money }}</button>
            }
          </div>
          <label class="lbl" for="custom">Or enter a custom amount</label>
          <div class="custom">
            <span>P</span>
            <input id="custom" type="number" inputmode="decimal" min="1" step="0.01" [max]="max()" [(ngModel)]="custom" (ngModelChange)="onCustom($event)" placeholder="0.00" />
          </div>
          <p class="muted tiny">Maximum {{ max() | money }} per demo deposit.</p>

          <div class="summary">
            <div class="row-between"><span class="muted">Demo deposit</span><strong class="money">{{ (amount() ?? 0) | money:'demo' }}</strong></div>
            <div class="row-between"><span class="muted">Current available</span><span class="money">{{ auth.wallet()?.available | money }}</span></div>
            <div class="row-between total"><span>New available balance</span><strong class="money">{{ (auth.wallet()?.available ?? 0) + (amount() ?? 0) | money:'demo' }}</strong></div>
          </div>

          @if (error()) { <div class="form-error"><mat-icon>error</mat-icon>{{ error() }}</div> }
          <button class="btn btn-primary btn-lg btn-block" [disabled]="loading()" (click)="submit()">
            @if (loading()) { <mat-spinner diameter="20" /> } @else { Add {{ (amount() ?? 0) | money }} demo funds }
          </button>
          <p class="muted tiny center">Simulated transaction for testing only. No payment provider is contacted and no card or mobile money account is charged.</p>
        }
      </div>
    </div>
  `,
  styleUrl: './wallet-forms.scss',
})
export class DepositPage {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private configStore = inject(ConfigStore);
  protected presets = computed(() => this.configStore.config()?.depositPresets ?? [10, 20, 50, 100, 200, 500, 1000]);
  protected max = computed(() => this.configStore.config()?.maxDeposit ?? 10000);
  protected amount = signal<number | null>(100);
  protected custom: number | null = null;
  protected loading = signal(false);
  protected error = signal('');
  protected success = signal<{ amount: number; wallet: Wallet } | null>(null);

  choose(p: number) { this.custom = null; this.amount.set(p); this.error.set(''); }
  onCustom(v: number | null) { this.amount.set(v === null || (v as unknown) === '' ? null : Number(v)); this.error.set(''); }
  reset() { this.success.set(null); this.custom = null; this.amount.set(100); }

  async submit() {
    const a = this.amount();
    if (a === null || !Number.isFinite(a) || a <= 0) { this.error.set('Enter an amount greater than zero.'); return; }
    if (Math.round(a * 100) !== a * 100 && Math.abs(Math.round(a * 100) - a * 100) > 1e-6) { this.error.set('Amounts can have at most 2 decimal places.'); return; }
    if (a > this.max()) { this.error.set(`The maximum demo deposit is ${formatMoney(this.max())}.`); return; }
    this.loading.set(true);
    this.error.set('');
    try {
      const r = await this.api.post<{ wallet: Wallet; amount: number }>('/wallet/demo-deposit', { amount: a });
      this.auth.wallet.set(r.wallet);
      this.success.set({ amount: r.amount, wallet: r.wallet });
    } catch (err) { this.error.set(apiError(err).message); } finally { this.loading.set(false); }
  }
}
