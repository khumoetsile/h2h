import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Subject, debounceTime } from 'rxjs';
import { Api } from '../../core/api.service';
import { MatchStatus, Paged } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { EmptyState, GameIcon, LoadError, MatchStatusChip, SkeletonList } from '../../shared/ui';

interface AdminMatch {
  id: number; code: string; status: MatchStatus; source: string; game: { id: number; name: string; slug: string; accentColor: string };
  stake: number; pool: number; fee: number; prize: number; players: string[]; winner: string | null; isDraw: boolean;
  createdAt: string; completedAt: string | null; cancelReason: string | null;
}

@Component({
  selector: 'app-admin-matches',
  imports: [FormsModule, DatePipe, MatIconModule, MoneyPipe, EmptyState, GameIcon, LoadError, MatchStatusChip, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Matches</h1><p class="sub">{{ data()?.total ?? 0 }} matches · amounts are DEMO</p></div></div>
      <div class="filters">
        <div class="search"><mat-icon>search</mat-icon><input [(ngModel)]="search" (ngModelChange)="search$.next($event)" placeholder="Match ID or username" /></div>
        <div class="segmented">
          @for (s of statuses; track s.key) { <button [class.active]="status() === s.key" (click)="setStatus(s.key)">{{ s.label }}</button> }
        </div>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="go(1)" /> }
        @else if (!data()) { <app-skeleton-list [rows]="8" /> }
        @else if (data()!.items.length === 0) { <app-empty icon="sports_esports" title="No matches found" /> }
        @else {
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Match ID</th><th>Game</th><th>Players</th><th>Status</th><th class="right">Stake</th><th class="right">Fee</th><th>Winner</th><th>Created</th><th></th></tr></thead>
            <tbody>
              @for (m of data()!.items; track m.id) {
                <tr class="clickable" (click)="router.navigate(['/matches', m.code])">
                  <td class="small">{{ m.code }}@if (m.source === 'CHALLENGE') { <span class="chip">challenge</span> }</td>
                  <td><div class="row"><app-game-icon [slug]="m.game.slug" [color]="m.game.accentColor" [size]="24" />{{ m.game.name }}</div></td>
                  <td>{{ m.players.join(' vs ') }}</td>
                  <td><app-match-status [status]="m.status" /></td>
                  <td class="right money">{{ m.stake | money }}</td>
                  <td class="right money">{{ (m.status === 'COMPLETED' && !m.isDraw ? m.fee : 0) | money }}</td>
                  <td>{{ m.winner ? '@' + m.winner : m.isDraw ? 'Draw' : '-' }}</td>
                  <td class="muted">{{ m.createdAt | date: 'd MMM, HH:mm' }}</td>
                  <td class="right" (click)="$event.stopPropagation()">
                    @if (['WAITING','MATCHED','READY','IN_PROGRESS'].includes(m.status)) {
                      <button class="btn btn-sm btn-danger" [disabled]="busy() === m.id" (click)="cancel(m)">Cancel & refund</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table></div>
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
export class AdminMatchesPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  protected router = inject(Router);
  private destroyRef = inject(DestroyRef);
  protected statuses = [
    { key: '', label: 'All' }, { key: 'ACTIVE', label: 'Active' }, { key: 'COMPLETED', label: 'Completed' }, { key: 'CANCELLED', label: 'Cancelled' },
  ];
  protected status = signal('');
  protected data = signal<Paged<AdminMatch> | null>(null);
  protected error = signal('');
  protected busy = signal<number | null>(null);
  protected search = '';
  protected search$ = new Subject<string>();

  ngOnInit() {
    this.go(1);
    this.search$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.go(1));
  }
  pages() { const d = this.data(); return d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1; }
  setStatus(s: string) { this.status.set(s); this.go(1); }

  async go(page: number) {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<AdminMatch>>('/admin/matches', { status: this.status(), search: this.search, page, pageSize: 25 }));
    } catch { this.error.set('Could not load matches.'); }
  }

  async cancel(m: AdminMatch) {
    if (!confirm(`Cancel ${m.code} and refund all locked demo stakes?`)) return;
    this.busy.set(m.id);
    try {
      await this.api.post(`/admin/matches/${m.id}/cancel`);
      this.toast.success(`${m.code} cancelled and refunded.`);
      await this.go(this.data()?.page ?? 1);
    } catch (err) { this.toast.error(err); } finally { this.busy.set(null); }
  }
}
