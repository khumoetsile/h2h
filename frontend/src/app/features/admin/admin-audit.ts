import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Subject, debounceTime } from 'rxjs';
import { Api } from '../../core/api.service';
import { Paged } from '../../core/models';
import { EmptyState, LoadError, SkeletonList } from '../../shared/ui';

interface AuditEvent {
  id: number;
  createdAt: string;
  actorType: 'PLAYER' | 'ADMIN' | 'SYSTEM' | 'BOT';
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  matchId: number | null;
  matchCode: string | null;
  challengeId: number | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  previousState: string | null;
  newState: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

/** Turns a stable action code into a plain-language sentence a non-technical admin can read at a glance. */
const ACTION_LABEL: Record<string, string> = {
  USER_REGISTERED: 'Account registered', LOGIN_SUCCESS: 'Signed in', LOGIN_FAILED: 'Sign-in failed', LOGOUT: 'Signed out',
  PASSWORD_CHANGED: 'Password changed', USER_DISABLED: 'User disabled', USER_ENABLED: 'User enabled', USER_NOTIFIED: 'Admin sent a notification',
  MATCH_CREATED: 'Match created', MATCH_JOINED: 'Opponent joined', PLAYER_READY: 'Player marked ready', MATCH_READY: 'Both players ready',
  MATCH_STARTED: 'Match started', GAMEPLAY_STARTED: 'Player started gameplay', ANSWER_SUBMITTED: 'Answer submitted', ANSWER_REJECTED: 'Answer rejected',
  MATCH_COMPLETED: 'Match completed', MATCH_CANCELLED: 'Match cancelled', MATCH_VOID: 'Match voided', SETTLEMENT_CREATED: 'Settlement recorded',
  CHALLENGE_CREATED: 'Challenge sent', CHALLENGE_ACCEPTED: 'Challenge accepted', CHALLENGE_DECLINED: 'Challenge declined',
  CHALLENGE_CANCELLED: 'Challenge cancelled', CHALLENGE_EXPIRED: 'Challenge expired',
  SETTINGS_UPDATED: 'Platform settings changed', GAME_ENABLED: 'Game enabled', GAME_DISABLED: 'Game disabled',
  FOOTBALL_COMPETITION_ENABLED: 'Football competition enabled', FOOTBALL_COMPETITION_DISABLED: 'Football competition disabled',
  FOOTBALL_TYPE_ENABLED: 'Football question enabled', FOOTBALL_TYPE_DISABLED: 'Football question disabled',
};
const ACTOR_LABEL: Record<string, string> = { PLAYER: 'Player', ADMIN: 'Admin', SYSTEM: 'System', BOT: 'Practice opponent' };

/**
 * Unified audit trail: every important action across auth, match/challenge
 * lifecycle, gameplay, wallet and admin events, filterable and shown as a
 * chronological timeline — "why did this happen" should be answerable here
 * without touching the database directly.
 */
@Component({
  selector: 'app-admin-audit',
  imports: [FormsModule, DatePipe, MatIconModule, EmptyState, LoadError, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Audit trail</h1><p class="sub">{{ data()?.total ?? 0 }} events · complete history of what happened, to whom, and why</p></div></div>

      <div class="filters audit-filters">
        <div class="search"><mat-icon>search</mat-icon><input [(ngModel)]="q" (ngModelChange)="q$.next($event)" placeholder="Search action, username, match code, reason…" /></div>
        <div class="segmented">
          @for (a of actorTypes; track a.key) { <button [class.active]="actorType() === a.key" (click)="setActorType(a.key)">{{ a.label }}</button> }
        </div>
      </div>
      <div class="filters audit-filters-2">
        <input class="num-filter" type="number" [(ngModel)]="matchIdFilter" (ngModelChange)="go(1)" placeholder="Match ID" />
        <input class="num-filter" type="number" [(ngModel)]="challengeIdFilter" (ngModelChange)="go(1)" placeholder="Challenge ID" />
        <input class="num-filter" type="number" [(ngModel)]="userIdFilter" (ngModelChange)="go(1)" placeholder="User ID" />
      </div>

      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="go(1)" /> }
        @else if (!data()) { <app-skeleton-list [rows]="8" /> }
        @else if (data()!.items.length === 0) { <app-empty icon="history" title="No matching events" text="Try widening your filters." /> }
        @else {
          <div class="timeline">
            @for (e of data()!.items; track e.id) {
              <div class="tl-row">
                <div class="tl-time muted small">{{ e.createdAt | date: 'd MMM y, HH:mm:ss' }}</div>
                <div class="tl-body">
                  <div class="tl-head">
                    <strong>{{ label(e.action) }}</strong>
                    <span class="chip" [class]="actorChip(e.actorType)">{{ actor(e.actorType) }}</span>
                    @if (e.previousState || e.newState) { <span class="muted tiny">{{ e.previousState ?? '—' }} → {{ e.newState ?? '—' }}</span> }
                  </div>
                  <div class="tl-meta small muted">
                    @if (e.actorUsername) { <span>User: {{ e.actorUsername }} ({{ e.actorUserId }})</span> }
                    @if (e.matchCode) { <span>Match: {{ e.matchCode }}</span> }
                    @if (e.challengeId) { <span>Challenge: #{{ e.challengeId }}</span> }
                    @if (e.entityType && !e.matchCode) { <span>{{ e.entityType }}@if (e.entityId) { #{{ e.entityId }} }</span> }
                  </div>
                  @if (e.reason) { <div class="tl-reason small">{{ e.reason }}</div> }
                  @if (e.metadata) { <div class="tl-meta-json tiny muted">{{ json(e.metadata) }}</div> }
                </div>
              </div>
            }
          </div>
          <div class="pager">
            <button class="btn btn-sm" [disabled]="data()!.page <= 1" (click)="go(data()!.page - 1)">Prev</button>
            <span class="muted small">Page {{ data()!.page }} of {{ pages() }}</span>
            <button class="btn btn-sm" [disabled]="data()!.page >= pages()" (click)="go(data()!.page + 1)">Next</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .audit-filters, .audit-filters-2 { margin-bottom: 10px; }
    .num-filter { width: 120px; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text); font: inherit; }
    .timeline { display: flex; flex-direction: column; }
    .tl-row { display: grid; grid-template-columns: 160px 1fr; gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .tl-row:last-child { border-bottom: 0; }
    .tl-time { white-space: nowrap; padding-top: 2px; }
    .tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .tl-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 2px; }
    .tl-reason { color: var(--text-2); margin-top: 4px; }
    .tl-meta-json { margin-top: 4px; font-family: monospace; word-break: break-all; }
    @media (max-width: 640px) { .tl-row { grid-template-columns: 1fr; } .tl-time { padding-top: 0; } }
  `],
  styleUrl: './admin-common.scss',
})
export class AdminAuditPage implements OnInit {
  private api = inject(Api);
  private destroyRef = inject(DestroyRef);

  protected actorTypes = [
    { key: '', label: 'All' }, { key: 'PLAYER', label: 'Player' }, { key: 'ADMIN', label: 'Admin' }, { key: 'SYSTEM', label: 'System' }, { key: 'BOT', label: 'Bot' },
  ];
  protected actorType = signal('');
  protected q = '';
  protected q$ = new Subject<string>();
  protected matchIdFilter: number | null = null;
  protected challengeIdFilter: number | null = null;
  protected userIdFilter: number | null = null;

  protected data = signal<Paged<AuditEvent> | null>(null);
  protected error = signal('');

  ngOnInit() {
    this.go(1);
    this.q$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.go(1));
  }

  pages() { const d = this.data(); return d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1; }
  setActorType(k: string) { this.actorType.set(k); this.go(1); }
  label(a: string) { return ACTION_LABEL[a] ?? a; }
  actor(a: string) { return ACTOR_LABEL[a] ?? a; }
  actorChip(a: string) {
    if (a === 'ADMIN') return 'chip chip-accent';
    if (a === 'SYSTEM') return 'chip';
    if (a === 'BOT') return 'chip chip-demo';
    return 'chip chip-info';
  }
  json(m: Record<string, unknown>) {
    try { return JSON.stringify(m); } catch { return ''; }
  }

  async go(page: number) {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<AuditEvent>>('/admin/audit-events', {
        q: this.q, actorType: this.actorType(), matchId: this.matchIdFilter, challengeId: this.challengeIdFilter,
        userId: this.userIdFilter, page, pageSize: 30,
      }));
    } catch { this.error.set('Could not load the audit trail.'); }
  }
}
