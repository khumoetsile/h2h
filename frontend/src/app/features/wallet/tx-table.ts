import { Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Transaction, TxType } from '../../core/models';
import { MoneyPipe } from '../../shared/pipes';

export const TX_LABEL: Record<TxType, string> = {
  DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal', GAME_ENTRY: 'Game entry', GAME_WIN: 'Game win', REFUND: 'Refund', FORFEIT: 'Stake forfeited',
};
const TX_ICON: Record<TxType, string> = {
  DEPOSIT: 'south_west', WITHDRAWAL: 'north_east', GAME_ENTRY: 'lock', GAME_WIN: 'emoji_events', REFUND: 'undo', FORFEIT: 'trending_down',
};

/** Transaction history: table on desktop, stacked list on mobile. */
@Component({
  selector: 'app-tx-table',
  imports: [DatePipe, RouterLink, MatIconModule, MoneyPipe],
  template: `
    <div class="table-wrap hide-mobile">
      <table class="table">
        <thead><tr><th>Date</th>@if (showUser()) { <th>User</th> }<th>Type</th><th>Description</th><th class="right">Amount</th><th class="right">Balance</th><th>Status</th></tr></thead>
        <tbody>
          @for (t of items(); track t.id) {
            <tr>
              <td class="muted">{{ t.createdAt | date: 'd MMM y, HH:mm' }}</td>
              @if (showUser()) { <td>&#64;{{ t.username }}</td> }
              <td><span class="type" [attr.data-t]="t.type"><mat-icon>{{ icon(t.type) }}</mat-icon>{{ label(t.type) }}</span></td>
              <td class="desc">
                {{ t.description }}
                @if (t.matchCode) { <a class="link tiny" [routerLink]="['/matches', t.matchCode]">{{ t.matchCode }}</a> }
                @if (showUser()) { <div class="muted tiny">{{ t.reference }}</div> }
              </td>
              <td class="right money" [class.win]="t.signedAmount > 0">{{ t.signedAmount | money:'sign' }}</td>
              <td class="right money">{{ t.balanceAfter | money }}</td>
              <td><span class="chip" [class.chip-demo]="t.status === 'DEMO_COMPLETED'" [class.chip-win]="t.status === 'COMPLETED'">{{ t.status.replace('_', ' ') }}</span></td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    <div class="list hide-desktop">
      @for (t of items(); track t.id) {
        <div class="list-item">
          <span class="ico" [attr.data-t]="t.type"><mat-icon>{{ icon(t.type) }}</mat-icon></span>
          <div class="grow">
            <div class="t">{{ label(t.type) }} @if (showUser()) { <span class="muted small">&#64;{{ t.username }}</span> }</div>
            <div class="muted tiny ellipsis">{{ t.description }}</div>
            <div class="muted tiny">{{ t.createdAt | date: 'd MMM, HH:mm' }} · <span [class.demo]="t.status === 'DEMO_COMPLETED'">{{ t.status.replace('_', ' ') }}</span></div>
          </div>
          <div class="end">
            <strong class="money" [class.win]="t.signedAmount > 0">{{ t.signedAmount | money:'sign' }}</strong>
            <span class="muted tiny money">Bal {{ t.balanceAfter | money }}</span>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .type { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; mat-icon { font-size: 18px; width: 18px; height: 18px; } }
    .desc { white-space: normal; min-width: 240px; max-width: 420px; font-size: 13px; }
    [data-t="DEPOSIT"], [data-t="GAME_WIN"] { color: var(--win); }
    [data-t="WITHDRAWAL"], [data-t="FORFEIT"] { color: var(--loss); }
    [data-t="GAME_ENTRY"] { color: var(--demo); }
    [data-t="REFUND"] { color: var(--info); }
    .ico { width: 34px; height: 34px; border-radius: 8px; background: var(--surface-2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .grow { flex: 1; min-width: 0; } .t { font-weight: 600; font-size: 14px; }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .end { display: flex; flex-direction: column; align-items: flex-end; }
    .demo { color: var(--demo); }
  `],
})
export class TxTable {
  readonly items = input.required<Transaction[]>();
  readonly showUser = input(false);
  label(t: TxType) { return TX_LABEL[t]; }
  icon(t: TxType) { return TX_ICON[t]; }
}
