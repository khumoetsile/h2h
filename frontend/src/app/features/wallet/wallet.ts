import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Paged, Transaction, Wallet } from '../../core/models';
import { MoneyPipe } from '../../shared/pipes';
import { DemoBadge, EmptyState, LoadError, SkeletonList } from '../../shared/ui';
import { TxTable } from './tx-table';

@Component({
  selector: 'app-wallet',
  imports: [RouterLink, MatIconModule, MoneyPipe, DemoBadge, EmptyState, LoadError, SkeletonList, TxTable],
  template: `
    <div class="page">
      <div class="page-head">
        <div><h1>Demo wallet</h1><p class="sub">Simulated balance for testing the full platform experience.</p></div>
      </div>
      <div class="demo-strip" style="margin-bottom:16px"><mat-icon>info</mat-icon> Demo wallet · Demo funds · No real money: nothing here can be deposited or withdrawn for real</div>

      <section class="balances">
        <div class="card bal main">
          <div class="row-between"><span class="lbl">Available balance</span><app-demo-badge label="Demo funds" /></div>
          <div class="amt money">{{ auth.wallet()?.available | money }}<span class="suffix">DEMO</span></div>
          <p class="muted small">Ready to stake or withdraw.</p>
          <div class="acts">
            <a class="btn btn-primary" routerLink="/wallet/deposit"><mat-icon>add</mat-icon>Add demo funds</a>
            <a class="btn" routerLink="/wallet/withdraw"><mat-icon>north_east</mat-icon>Withdraw (demo)</a>
          </div>
        </div>
        <div class="card bal">
          <span class="lbl">Locked balance</span>
          <div class="amt sm money">{{ auth.wallet()?.locked | money }}<span class="suffix">DEMO</span></div>
          <p class="muted small">Stakes held in active matches. Released on win, refunded on cancel/draw.</p>
        </div>
        <div class="card bal">
          <span class="lbl">Total balance</span>
          <div class="amt sm money">{{ auth.wallet()?.total | money }}<span class="suffix">DEMO</span></div>
          <p class="muted small">Available + locked.</p>
        </div>
      </section>

      <div class="section-title" style="margin-top:24px"><h2>Recent transactions</h2><a routerLink="/wallet/transactions">View all & filter</a></div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
        @else if (!tx()) { <app-skeleton-list [rows]="5" /> }
        @else if (tx()!.items.length === 0) {
          <app-empty icon="receipt_long" title="No transactions yet" text="Deposits, stakes, winnings and refunds will appear here.">
            <a class="btn btn-sm btn-primary" routerLink="/wallet/deposit">Add demo funds</a>
          </app-empty>
        } @else { <app-tx-table [items]="tx()!.items" /> }
      </div>
    </div>
  `,
  styles: [`
    .demo-strip mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .balances { display: grid; gap: 16px; grid-template-columns: 1fr; }
    @media (min-width: 900px) { .balances { grid-template-columns: 1.4fr 1fr 1fr; } }
    .bal { display: flex; flex-direction: column; gap: 6px; }
    .main { border-color: rgba(217,180,74,.35); background: var(--surface); }
    .lbl { color: var(--muted); font-size: 12px; font-weight: 600; }
    .amt { font-family: var(--font-display); font-size: 40px; font-weight: 700; }
    .amt.sm { font-size: 28px; }
    .suffix { font-size: 13px; color: var(--demo); margin-left: 8px; vertical-align: middle; }
    .acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  `],
})
export class WalletPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  protected tx = signal<Paged<Transaction> | null>(null);
  protected error = signal('');

  ngOnInit() { this.load(); }

  async load() {
    this.error.set('');
    try {
      const [w, tx] = await Promise.all([
        this.api.get<{ wallet: Wallet }>('/wallet'),
        this.api.get<Paged<Transaction>>('/wallet/transactions', { pageSize: 8 }),
      ]);
      this.auth.wallet.set(w.wallet);
      this.tx.set(tx);
    } catch { this.error.set('Could not load your wallet.'); }
  }
}
