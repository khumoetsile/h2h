import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { Paged, Transaction, TxType } from '../../core/models';
import { DemoBadge, EmptyState, LoadError, SkeletonList } from '../../shared/ui';
import { TxTable, TX_LABEL } from './tx-table';

@Component({
  selector: 'app-transactions',
  imports: [FormsModule, RouterLink, MatIconModule, DemoBadge, EmptyState, LoadError, SkeletonList, TxTable],
  template: `
    <div class="page">
      <a class="back muted small" routerLink="/wallet"><mat-icon>arrow_back</mat-icon>Wallet</a>
      <div class="page-head"><div><h1>Transaction history</h1><p class="sub">{{ data()?.total ?? 0 }} demo transactions</p></div><app-demo-badge label="Demo ledger" size="lg" /></div>
      <div class="filters">
        <div class="segmented">
          <button [class.active]="!type()" (click)="setType(null)">All</button>
          @for (t of types; track t) { <button [class.active]="type() === t" (click)="setType(t)">{{ label(t) }}</button> }
        </div>
        <div class="dates">
          <label>From <input type="date" [(ngModel)]="from" (change)="reload()" /></label>
          <label>To <input type="date" [(ngModel)]="to" (change)="reload()" /></label>
          @if (from || to) { <button class="btn btn-ghost btn-sm" (click)="from = ''; to = ''; reload()">Clear dates</button> }
        </div>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="reload()" /> }
        @else if (!data()) { <app-skeleton-list [rows]="8" /> }
        @else if (data()!.items.length === 0) { <app-empty icon="receipt_long" title="No transactions yet" [text]="type() || from || to ? 'No transactions match these filters.' : 'Your demo deposits, stakes and winnings will appear here.'" /> }
        @else {
          <app-tx-table [items]="data()!.items" />
          <div class="pager">
            <button class="btn btn-sm" [disabled]="data()!.page <= 1" (click)="go(data()!.page - 1)"><mat-icon>chevron_left</mat-icon>Prev</button>
            <span class="muted small">Page {{ data()!.page }} of {{ pages() }}</span>
            <button class="btn btn-sm" [disabled]="data()!.page >= pages()" (click)="go(data()!.page + 1)">Next<mat-icon>chevron_right</mat-icon></button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; mat-icon { font-size: 18px; width: 18px; height: 18px; } }
    .filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .dates { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--muted);
      input { margin-left: 6px; height: 34px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; color-scheme: dark; } }
    .pager { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-top: 1px solid var(--border); }
  `],
})
export class TransactionsPage implements OnInit {
  private api = inject(Api);
  protected types: TxType[] = ['DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'GAME_WIN', 'REFUND', 'FORFEIT', 'ABANDONMENT_FEE'];
  protected type = signal<TxType | null>(null);
  protected data = signal<Paged<Transaction> | null>(null);
  protected error = signal('');
  protected from = '';
  protected to = '';

  ngOnInit() { this.go(1); }
  label(t: TxType) { return TX_LABEL[t]; }
  pages() { const d = this.data(); return d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1; }
  setType(t: TxType | null) { this.type.set(t); this.reload(); }
  reload() { this.data.set(null); this.go(1); }

  async go(page: number) {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<Transaction>>('/wallet/transactions', {
        type: this.type(), page, pageSize: 15,
        from: this.from ? new Date(this.from + 'T00:00:00').toISOString() : null,
        to: this.to ? new Date(this.to + 'T23:59:59').toISOString() : null,
      }));
    } catch { this.error.set('Could not load transactions.'); }
  }
}
