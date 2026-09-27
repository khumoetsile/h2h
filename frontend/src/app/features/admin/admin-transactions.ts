import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Subject, debounceTime } from 'rxjs';
import { Api } from '../../core/api.service';
import { Paged, Transaction, TxType } from '../../core/models';
import { DemoBadge, EmptyState, LoadError, SkeletonList } from '../../shared/ui';
import { TX_LABEL, TxTable } from '../wallet/tx-table';

@Component({
  selector: 'app-admin-transactions',
  imports: [FormsModule, MatIconModule, DemoBadge, EmptyState, LoadError, SkeletonList, TxTable],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Transactions</h1><p class="sub">{{ data()?.total ?? 0 }} ledger entries @if (userId) { for user #{{ userId }} }</p></div><app-demo-badge label="Demo ledger" size="lg" /></div>
      <div class="filters">
        <div class="search"><mat-icon>search</mat-icon><input [(ngModel)]="search" (ngModelChange)="search$.next($event)" placeholder="Reference, description or username" /></div>
        <div class="segmented">
          <button [class.active]="!type()" (click)="setType(null)">All</button>
          @for (t of types; track t) { <button [class.active]="type() === t" (click)="setType(t)">{{ label(t) }}</button> }
        </div>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="go(1)" /> }
        @else if (!data()) { <app-skeleton-list [rows]="8" /> }
        @else if (data()!.items.length === 0) { <app-empty icon="receipt_long" title="No transactions yet" text="No ledger entries match these filters." /> }
        @else {
          <app-tx-table [items]="data()!.items" [showUser]="true" />
          <div class="pager">
            <button class="btn btn-sm" [disabled]="data()!.page <= 1" (click)="go(data()!.page - 1)">Prev</button>
            <span class="muted small">Page {{ data()!.page }} of {{ pages() }}</span>
            <button class="btn btn-sm" [disabled]="data()!.page >= pages()" (click)="go(data()!.page + 1)">Next</button>
          </div>
        }
      </div>
    </div>
  `,
  styleUrl: './admin-common.scss',
})
export class AdminTransactionsPage implements OnInit {
  private api = inject(Api);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  protected types: TxType[] = ['DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'GAME_WIN', 'REFUND', 'FORFEIT', 'ABANDONMENT_FEE'];
  protected type = signal<TxType | null>(null);
  protected data = signal<Paged<Transaction> | null>(null);
  protected error = signal('');
  protected search = '';
  protected userId: string | null = null;
  protected search$ = new Subject<string>();

  ngOnInit() {
    this.userId = this.route.snapshot.queryParamMap.get('userId');
    this.go(1);
    this.search$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.go(1));
  }
  label(t: TxType) { return TX_LABEL[t]; }
  pages() { const d = this.data(); return d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1; }
  setType(t: TxType | null) { this.type.set(t); this.go(1); }

  async go(page: number) {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<Transaction>>('/admin/transactions', { type: this.type(), search: this.search, userId: this.userId, page, pageSize: 25 }));
    } catch { this.error.set('Could not load transactions.'); }
  }
}
