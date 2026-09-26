import { Component, inject, input, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { MatchSummary, Transaction, User, UserStats, Wallet } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, EmptyState, GameIcon, LoadError, OutcomeChip, Spinner } from '../../shared/ui';
import { TxTable } from '../wallet/tx-table';

interface Detail { user: User; wallet: Wallet; stats: UserStats; transactions: Transaction[]; matches: MatchSummary[]; }

@Component({
  selector: 'app-admin-user-detail',
  imports: [FormsModule, DatePipe, RouterLink, MatIconModule, MoneyPipe, Avatar, DemoBadge, EmptyState, GameIcon, LoadError, OutcomeChip, Spinner, TxTable],
  template: `
    <div class="page">
      <a class="back muted small" routerLink="/admin/users"><mat-icon>arrow_back</mat-icon>Users</a>
      @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
      @else if (!d()) { <app-spinner /> }
      @else {
        @let x = d()!;
        <section class="card head">
          <app-avatar [name]="x.user.username" [color]="x.user.avatarColor" [size]="64" />
          <div class="grow">
            <h1>&#64;{{ x.user.username }} <span class="chip" [class.chip-win]="x.user.status === 'ACTIVE'" [class.chip-loss]="x.user.status === 'DISABLED'">{{ x.user.status }}</span>
              @if (x.user.isDemoData) { <span class="chip chip-demo">demo data</span> }</h1>
            <div class="muted small">{{ x.user.firstName }} {{ x.user.lastName }} · {{ x.user.email }} · {{ x.user.phone }}</div>
            <div class="muted tiny">Role {{ x.user.role }} · Joined {{ x.user.createdAt | date: 'd MMM y' }} · Last seen {{ x.user.lastSeenAt ? (x.user.lastSeenAt | date: 'd MMM, HH:mm') : 'never' }}</div>
          </div>
          @if (x.user.id !== auth.user()?.id) {
            <button class="btn" [class.btn-danger]="x.user.status === 'ACTIVE'" [disabled]="busy()" (click)="toggle()">
              <mat-icon>{{ x.user.status === 'ACTIVE' ? 'block' : 'check_circle' }}</mat-icon>{{ x.user.status === 'ACTIVE' ? 'Disable account' : 'Enable account' }}
            </button>
          }
        </section>

        <div class="grid3">
          <div class="card">
            <div class="row-between"><h3>Wallet</h3><app-demo-badge /></div>
            <div class="wl"><span class="muted">Available</span><strong class="money">{{ x.wallet.available | money }}</strong></div>
            <div class="wl"><span class="muted">Locked</span><strong class="money">{{ x.wallet.locked | money }}</strong></div>
            <div class="wl"><span class="muted">Total</span><strong class="money">{{ x.wallet.total | money }}</strong></div>
            <p class="muted tiny">Balances can only change through the ledger (deposits, matches, withdrawals).</p>
          </div>
          <div class="card">
            <h3>Record</h3>
            <div class="wl"><span class="muted">Played</span><strong>{{ x.stats.played }}</strong></div>
            <div class="wl"><span class="muted">W / L / D</span><strong>{{ x.stats.wins }} / {{ x.stats.losses }} / {{ x.stats.draws }}</strong></div>
            <div class="wl"><span class="muted">Win rate · streak</span><strong>{{ x.stats.winRate }}% · {{ x.stats.streak.label }}</strong></div>
            <div class="wl"><span class="muted">Demo winnings</span><strong class="money">{{ x.stats.totalWinnings | money }}</strong></div>
          </div>
          <div class="card">
            <h3>Send notification</h3>
            <input class="inp" [(ngModel)]="nTitle" placeholder="Title" maxlength="120" />
            <textarea class="inp" [(ngModel)]="nMsg" placeholder="Message" maxlength="255" rows="3"></textarea>
            <button class="btn btn-sm" [disabled]="!nTitle || !nMsg" (click)="sendNote()"><mat-icon>send</mat-icon>Send</button>
          </div>
        </div>

        <div class="section-title" style="margin-top:20px"><h2>Recent matches</h2></div>
        <div class="card card-flush">
          @if (x.matches.length === 0) { <app-empty icon="sports_esports" title="No matches yet" /> }
          @else {
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Game</th><th>Opponent</th><th>Stake</th><th>Result</th><th>Date</th><th>Match ID</th></tr></thead>
              <tbody>
                @for (m of x.matches; track m.id) {
                  <tr class="clickable" (click)="router.navigate(['/matches', m.code])">
                    <td><div class="row"><app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="24" />{{ m.game.name }}</div></td>
                    <td>&#64;{{ m.opponent?.username ?? '—' }}</td>
                    <td class="money">{{ m.stake | money }}</td>
                    <td><app-outcome [outcome]="m.outcome" [status]="m.status" /></td>
                    <td class="muted">{{ m.createdAt | date: 'd MMM, HH:mm' }}</td>
                    <td class="muted small">{{ m.code }}</td>
                  </tr>
                }
              </tbody>
            </table></div>
          }
        </div>

        <div class="section-title" style="margin-top:20px"><h2>Recent transactions</h2><a [routerLink]="['/admin/transactions']" [queryParams]="{ userId: x.user.id }">All</a></div>
        <div class="card card-flush">
          @if (x.transactions.length === 0) { <app-empty icon="receipt_long" title="No transactions yet" /> } @else { <app-tx-table [items]="x.transactions" /> }
        </div>
      }
    </div>
  `,
  styleUrl: './admin-common.scss',
  styles: [`
    .head { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; .grow { flex: 1; min-width: 220px; } h1 { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 24px; } }
    .grid3 { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .grid3 .card { display: flex; flex-direction: column; gap: 8px; }
    .wl { display: flex; justify-content: space-between; font-size: 14px; }
    .inp { width: 100%; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 10px; font: inherit; font-size: 14px; resize: vertical; }
  `],
})
export class AdminUserDetailPage implements OnInit {
  readonly id = input.required<string>();
  private api = inject(Api);
  protected auth = inject(AuthService);
  private toast = inject(Toast);
  protected router = inject(Router);
  protected d = signal<Detail | null>(null);
  protected error = signal('');
  protected busy = signal(false);
  protected nTitle = '';
  protected nMsg = '';

  ngOnInit() { this.load(); }

  async load() {
    this.error.set('');
    try { this.d.set(await this.api.get<Detail>(`/admin/users/${this.id()}`)); } catch (err) { this.error.set(apiError(err).message); }
  }

  async toggle() {
    const u = this.d()!.user;
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (next === 'DISABLED' && !confirm(`Disable @${u.username}? They will be signed out immediately.`)) return;
    this.busy.set(true);
    try {
      const r = await this.api.post<{ user: User }>(`/admin/users/${u.id}/status`, { status: next });
      this.d.update((d) => d && { ...d, user: { ...d.user, status: r.user.status } });
      this.toast.success(`Account ${next === 'DISABLED' ? 'disabled' : 'enabled'}.`);
    } catch (err) { this.toast.error(err); } finally { this.busy.set(false); }
  }

  async sendNote() {
    try {
      await this.api.post(`/admin/users/${this.id()}/notify`, { title: this.nTitle, message: this.nMsg });
      this.toast.success('Notification sent.');
      this.nTitle = ''; this.nMsg = '';
    } catch (err) { this.toast.error(err); }
  }
}
