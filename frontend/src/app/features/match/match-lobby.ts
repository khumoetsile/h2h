import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { interval } from 'rxjs';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { MatchView } from '../../core/models';
import { RealtimeService } from '../../core/realtime.service';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, DemoBadge, GameIcon, LoadError, MatchStatusChip, Spinner } from '../../shared/ui';

@Component({
  selector: 'app-match-lobby',
  imports: [RouterLink, MatIconModule, MatProgressSpinnerModule, MoneyPipe, Avatar, DemoBadge, GameIcon, LoadError, MatchStatusChip, Spinner],
  templateUrl: './match-lobby.html',
  styleUrl: './match-lobby.scss',
})
export class MatchLobbyPage implements OnInit {
  readonly code = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  private toast = inject(Toast);
  private realtime = inject(RealtimeService);
  protected configStore = inject(ConfigStore);
  private destroyRef = inject(DestroyRef);

  protected match = signal<MatchView | null>(null);
  protected error = signal('');
  protected busy = signal<string | null>(null);
  protected now = signal(Date.now());

  protected me = computed(() => this.match()?.players.find((p) => p.userId === this.match()?.viewerId) ?? null);
  protected opponent = computed(() => this.match()?.players.find((p) => p.userId !== this.match()?.viewerId) ?? null);
  protected elapsed = computed(() => {
    const m = this.match();
    if (!m) return '0:00';
    const s = Math.max(0, Math.floor((this.now() - new Date(m.createdAt).getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
  protected countdownTo = (iso: string | null) => {
    if (!iso) return '';
    const s = Math.max(0, Math.floor((new Date(iso).getTime() - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  ngOnInit() {
    this.load();
    this.realtime.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      if (m.code === this.code()) this.apply(m);
    });
    // Polling fallback + clock tick
    interval(1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((i) => {
      this.now.set(Date.now());
      if (i % 4 === 3) this.load(true);
    });
  }

  private apply(m: MatchView) {
    const prev = this.match();
    this.match.set(m);
    if (prev && prev.status === 'WAITING' && m.status === 'MATCHED') this.toast.success(`Opponent found: @${this.opponent()?.username}`);
    if (m.status === 'COMPLETED' || m.status === 'CANCELLED') {
      this.router.navigate(['/matches', m.code], { replaceUrl: true });
    }
  }

  async load(silent = false) {
    try {
      const { match } = await this.api.get<{ match: MatchView }>(`/matches/${this.code()}`);
      this.apply(match);
      this.error.set('');
    } catch (err) {
      if (!silent || !this.match()) this.error.set(apiError(err).message);
    }
  }

  private async act(name: string, path: string, success?: string) {
    this.busy.set(name);
    try {
      const { match } = await this.api.post<{ match: MatchView }>(`/matches/${this.code()}/${path}`);
      if (success) this.toast.success(success);
      this.apply(match);
    } catch (err) {
      this.toast.error(err);
      this.load(true);
    } finally {
      this.busy.set(null);
    }
  }

  ready() { return this.act('ready', 'ready'); }
  cancel() {
    const m = this.match();
    const msg = m?.status === 'WAITING' ? 'Stop searching? Your locked stake will be refunded.' : 'Leave this match? Both stakes will be refunded.';
    if (!confirm(msg)) return;
    return this.act('cancel', 'cancel', 'Match cancelled — your demo stake was refunded.');
  }
  demoOpponent() { return this.act('bot', 'demo-opponent'); }
  play() { this.router.navigate(['/match', this.code(), 'play']); }
}
