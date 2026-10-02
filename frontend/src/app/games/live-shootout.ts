import { Component, DestroyRef, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api } from '../core/api.service';
import { apiError } from '../core/api-error';
import { RealtimeService } from '../core/realtime.service';
import { ServerClock } from '../core/server-clock';
import { Toast } from '../core/toast.service';
import {
  COL_NAMES, ShootoutKick, ShootoutState, ZONE_NAMES, markerAt, zoneCol, zoneIsHigh,
} from './shootout.model';

type Pip = 'goal' | 'saved' | 'miss' | 'now' | 'todo';

/** How long a result stays on screen before the next kick's countdown takes over. */
const REVEAL_MAX_MS = 4500;
/** After the last kick, how long before the end card appears / we move on. */
const END_CARD_DELAY_MS = 3200;
const POLL_MS = 2500;

/**
 * Live penalty shootout screen. The server runs the rules and keeps every
 * choice sealed until both players are in; this screen sends your own choice
 * and draws what the server tells it.
 *
 * Built to stay light on a phone: plain DOM and CSS, no images or canvas, no
 * per-frame Angular updates (the timing bar's marker is moved with a
 * transform from one animation-frame loop), and this component is its own
 * lazy chunk.
 */
@Component({
  selector: 'app-live-shootout',
  template: `
    @if (error()) {
      <div class="err"><p>{{ error() }}</p><button class="btn btn-primary" (click)="join()">Try again</button></div>
    } @else if (state(); as st) {
      <div class="so">
        <section class="board" aria-label="Score">
          @for (s of sides(); track s.userId) {
            <div class="side" [class.me]="s.me">
              <span class="name">{{ s.me ? 'You' : s.username }}</span>
              <span class="pips">@for (p of s.pips; track $index) { <i class="pip" [attr.data-s]="p"></i> }</span>
              <strong class="goals">{{ s.goals }}</strong>
            </div>
          }
        </section>
        <p class="status" aria-live="polite">
          {{ status() }}
          @if (st.suddenDeath && !st.done) { <span class="tag">Sudden death</span> }
          @if (secondsLeft() !== null) { <span class="clock">{{ secondsLeft() }}s</span> }
        </p>

        <div class="pitch">
          <div class="goal">
            @for (z of zones; track z) {
              <button type="button" class="cell"
                [class.sel]="aimZone() === z"
                [class.hot]="role() === 'KEEPER' && diveCol() === z % 3"
                [class.win]="hit() === z && revealed()?.outcome === 'GOAL'"
                [class.stop]="hit() === z && revealed()?.outcome === 'SAVED'"
                [disabled]="!canAct()"
                [attr.aria-label]="role() === 'KEEPER' ? 'Dive ' + colNames[z % 3] : 'Aim ' + zoneNames[z]"
                (click)="pick(z)"></button>
            }
            <div class="keeper" [style.left.%]="keeperPos().left" [style.transform]="'translateX(-50%) rotate(' + keeperPos().rot + 'deg)'"><span class="k-head"></span><span class="k-body"></span></div>
          </div>
          <div class="ball" [style.left.%]="ballPos().left" [style.top.%]="ballPos().top"></div>
          @if (banner(); as b) { <div class="banner" [attr.data-k]="b.kind"><strong>{{ b.title }}</strong><span>{{ b.sub }}</span></div> }
          @if (st.done && !revealed()) {
            <div class="end">
              <h2>{{ endTitle() }}</h2>
              <p>{{ endSub() }}</p>
              <button class="btn btn-primary btn-lg" (click)="finished.emit()">See result</button>
            </div>
          }
        </div>

        @if (role() === 'KICKER' && !st.done && !revealed()) {
          <div class="bar" [class.off]="!canAct() && !frozen()">
            <div class="track" #track>
              <i class="b-low"></i><i class="b-high"></i><i class="b-perfect"></i>
              <i class="marker" #marker></i>
            </div>
            <p class="legend">Stop it in the green. High corners need a tight stop; low shots are more forgiving.</p>
          </div>
        }

        @if (!st.done) {
          <button class="act" type="button" [disabled]="!canAct() || (role() === 'KICKER' ? aimZone() === null : diveCol() === null)" (pointerdown)="act($event)">
            {{ role() === 'KEEPER' ? 'Dive' : 'Shoot' }}
          </button>
        }
      </div>
    } @else {
      <p class="muted center">Taking the pitch…</p>
    }
  `,
  styles: [`
    :host { display: block; }
    .so { display: flex; flex-direction: column; gap: 10px; user-select: none; -webkit-user-select: none; touch-action: manipulation; max-width: 560px; margin: 0 auto; }
    .center { text-align: center; padding: 40px 0; }
    .err { text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 40px 0; }

    .board { display: flex; flex-direction: column; gap: 6px; background: var(--surface); border-radius: var(--radius); padding: 10px 14px; }
    .side { display: grid; grid-template-columns: minmax(0, 7.5em) 1fr auto; align-items: center; gap: 12px; }
    .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side.me .name { color: var(--accent); }
    .pips { display: flex; gap: 6px; flex-wrap: wrap; }
    .pip { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border-strong); box-sizing: border-box; }
    .pip[data-s='goal'] { background: var(--win); border-color: var(--win); }
    .pip[data-s='saved'] { background: var(--loss); border-color: var(--loss); }
    .pip[data-s='miss'] { background: var(--muted); border-color: var(--muted); }
    .pip[data-s='now'] { border-color: var(--text); }
    .goals { font-family: var(--font-display); font-size: 28px; line-height: 1; min-width: 1ch; text-align: right; }

    .status { min-height: 24px; text-align: center; color: var(--text-2); font-size: 17px; }
    .tag { margin-left: 8px; background: var(--demo-soft); color: var(--demo); border-radius: 3px; padding: 1px 7px; font-size: 14px; font-weight: 600; }
    .clock { margin-left: 8px; color: var(--muted); font-variant-numeric: tabular-nums; }

    .pitch { position: relative; width: 100%; aspect-ratio: 4 / 3; max-height: 46vh; min-height: 250px; background: #1b2e22; border-radius: var(--radius); overflow: hidden; contain: layout paint; }
    .goal { position: absolute; left: 8%; right: 8%; top: 8%; height: 44%; border: 5px solid #eceae3; border-bottom: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); }
    .cell { border: 0; border-right: 1px solid rgba(255,255,255,.14); border-bottom: 1px solid rgba(255,255,255,.14); background: transparent; cursor: pointer; padding: 0; }
    .cell:nth-child(3n) { border-right: 0; } .cell:nth-child(n+4) { border-bottom: 0; }
    .cell:disabled { cursor: default; }
    .cell.sel, .cell.hot { background: rgba(245, 112, 31, .28); box-shadow: inset 0 0 0 2px var(--accent); }
    .cell.win { background: rgba(92, 203, 138, .35); box-shadow: inset 0 0 0 2px var(--win); }
    .cell.stop { background: rgba(232, 98, 79, .35); box-shadow: inset 0 0 0 2px var(--loss); }
    .keeper { position: absolute; top: 26%; width: 14%; max-width: 54px; display: flex; flex-direction: column; align-items: center; transition: left .3s ease-out, transform .3s ease-out; pointer-events: none; }
    .k-head { width: 38%; aspect-ratio: 1; border-radius: 50%; background: #d9b44a; }
    .k-body { width: 100%; height: 56px; margin-top: 2px; border-radius: 10px 10px 3px 3px; background: #cfd3c8; }
    .ball { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #fff; border: 3px solid #14100c; box-sizing: border-box; transition: left .38s ease-out, top .38s ease-out; pointer-events: none; }
    .banner { position: absolute; left: 0; right: 0; top: 56%; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; pointer-events: none; }
    .banner strong { font-family: var(--font-display); font-size: 40px; line-height: 1; }
    .banner span { color: var(--text-2); font-size: 16px; }
    .banner[data-k='GOAL'] strong { color: var(--win); } .banner[data-k='SAVED'] strong { color: var(--loss); } .banner[data-k='MISSED'] strong { color: var(--muted); }
    .end { position: absolute; inset: 0; background: rgba(16, 19, 17, .92); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px; }
    .end h2 { font-size: 42px; } .end p { color: var(--text-2); margin-bottom: 8px; }

    .bar.off { opacity: .55; }
    .track { position: relative; height: 46px; background: #2a302b; border-radius: 4px; overflow: hidden; }
    .track i { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); }
    /* Band widths are twice the server's half-widths: low 0.34, high 0.20, perfect 0.07. */
    .b-low { width: 68%; background: #34403a; }
    .b-high { width: 40%; background: #3c6b4a; }
    .b-perfect { width: 14%; background: var(--win); }
    .marker { left: 0 !important; width: 4px; margin-left: -2px; background: #fff; will-change: transform; }
    .legend { margin-top: 6px; color: var(--muted); font-size: 14px; text-align: center; }

    .act { min-height: 68px; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); font-family: var(--font-display); font-size: 30px; font-weight: 700; cursor: pointer; text-align: center; }
    .act:disabled { opacity: .35; cursor: default; }
    @media (prefers-reduced-motion: reduce) { .keeper, .ball { transition-duration: .001ms; } }
  `],
})
export class LiveShootoutGame implements OnInit, OnDestroy {
  readonly code = input.required<string>();
  readonly finished = output<void>();

  private api = inject(Api);
  private realtime = inject(RealtimeService);
  private clock = inject(ServerClock);
  private toast = inject(Toast);
  private destroyRef = inject(DestroyRef);

  private trackEl = viewChild<ElementRef<HTMLElement>>('track');
  private markerEl = viewChild<ElementRef<HTMLElement>>('marker');

  protected zones = [0, 1, 2, 3, 4, 5];
  protected zoneNames = ZONE_NAMES;
  protected colNames = COL_NAMES;

  protected state = signal<ShootoutState | null>(null);
  protected error = signal('');
  protected aimZone = signal<number | null>(null);
  protected diveCol = signal<number | null>(null);
  protected frozen = signal<number | null>(null); // marker position kept after the kicker has shot
  protected revealed = signal<ShootoutKick | null>(null);
  private revealedAt = 0;
  private localLocked = signal(false);
  private busy = signal(false);
  protected tick = signal(Date.now());
  private seenKicks = -1;
  private roundNo = -1;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;

  private cur = computed(() => this.state()?.current ?? null);
  protected role = computed(() => this.cur()?.role ?? null);
  private nowMs = computed(() => { this.tick(); return this.clock.precise(); });
  private opp = computed(() => this.state()?.players.find((p) => p.userId !== this.state()!.viewerId) ?? null);

  protected locked = computed(() => !!this.cur()?.myLocked || this.localLocked());
  protected canAct = computed(() => {
    const c = this.cur(); const st = this.state();
    if (!c || !st || st.done || this.revealed() || this.locked() || this.busy()) return false;
    const now = this.nowMs();
    return now >= Date.parse(c.startsAt) && now <= Date.parse(c.deadline);
  });

  protected secondsLeft = computed(() => {
    const c = this.cur(); const st = this.state();
    if (!c || !st || st.done || this.revealed() || this.locked()) return null;
    const now = this.nowMs();
    if (now < Date.parse(c.startsAt)) return null;
    return Math.max(0, Math.ceil((Date.parse(c.deadline) - now) / 1000));
  });

  protected sides = computed(() => {
    const st = this.state();
    if (!st) return [];
    return st.players.map((p) => {
      const kicks = st.history.filter((k) => k.kickerId === p.userId);
      const pips: Pip[] = kicks.map((k) => (k.outcome === 'GOAL' ? 'goal' : k.outcome === 'SAVED' ? 'saved' : 'miss'));
      if (st.current?.kickerId === p.userId && !st.done) pips.push('now');
      while (pips.length < st.kicksPerSide) pips.push('todo');
      return { userId: p.userId, username: p.username, me: p.userId === st.viewerId, pips, goals: st.goals[p.userId] ?? 0 };
    });
  });

  /** The zone the last revealed kick was aimed at, while its result is on screen. */
  protected hit = computed(() => this.revealed()?.zone ?? -1);

  protected ballPos = computed(() => {
    const k = this.revealed();
    if (!k || k.zone == null) return { left: 50, top: 88 };
    const col = zoneCol(k.zone);
    const x = 8 + (84 * (col + 0.5)) / 3;
    if (k.outcome === 'MISSED') return zoneIsHigh(k.zone) ? { left: x, top: -8 } : { left: col === 0 ? 3 : col === 2 ? 97 : 94, top: 40 };
    return { left: x, top: zoneIsHigh(k.zone) ? 19 : 41 };
  });

  protected keeperPos = computed(() => {
    const k = this.revealed();
    const col = k ? k.keeperCol : 1;
    return { left: 8 + (84 * (col + 0.5)) / 3, rot: (col - 1) * 18 };
  });

  protected banner = computed(() => {
    const k = this.revealed();
    if (!k) return null;
    if (k.zone == null) return { kind: 'MISSED', title: 'No shot', sub: k.kickerId === this.state()?.viewerId ? 'You ran out of time' : 'They ran out of time' };
    const quality = k.quality === 'PERFECT' ? 'Perfect strike' : k.quality === 'POOR' ? (zoneIsHigh(k.zone) ? 'Over the bar' : 'Wide of the post') : k.outcome === 'SAVED' ? 'Keeper guessed right' : 'Keeper went the wrong way';
    return { kind: k.outcome, title: k.outcome === 'GOAL' ? 'Goal!' : k.outcome === 'SAVED' ? 'Saved!' : 'Missed!', sub: quality };
  });

  protected status = computed(() => {
    const st = this.state();
    if (!st) return '';
    if (st.done) return 'Shootout over';
    if (st.phase === 'LOBBY') return `Waiting for ${this.opp()?.username ?? 'your opponent'} to take the pitch`;
    const c = st.current;
    if (!c) return '';
    if (this.revealed()) return 'Next kick coming up';
    const toStart = Math.ceil((Date.parse(c.startsAt) - this.nowMs()) / 1000);
    if (toStart > 0) return `Kick ${c.no}: ${c.role === 'KICKER' ? 'you shoot' : 'you keep goal'}. Starting in ${toStart}`;
    if (this.locked()) return c.opponentLocked ? 'Both locked in' : `Locked in. Waiting for ${this.opp()?.username ?? 'your opponent'}`;
    if (c.role === 'KEEPER') return 'Pick a side to dive';
    return this.aimZone() === null ? 'Pick where to aim, then stop the bar in the green' : 'Stop the bar in the green, then shoot';
  });

  protected endTitle = computed(() => {
    const st = this.state();
    if (!st) return '';
    if (st.winnerId == null) return 'Level';
    return st.winnerId === st.viewerId ? 'You win' : 'You lose';
  });
  protected endSub = computed(() => {
    const st = this.state();
    if (!st) return '';
    const mine = st.goals[st.viewerId] ?? 0;
    const theirs = Object.entries(st.goals).filter(([id]) => Number(id) !== st.viewerId).map(([, g]) => g)[0] ?? 0;
    return st.winnerId == null ? `${mine}-${theirs} after sudden death. Stakes are refunded.` : `${mine}-${theirs}${st.suddenDeath ? ' after sudden death' : ''}`;
  });

  constructor() {
    // A new kick: clear last kick's selection and restore a locked-in choice after a reload.
    effect(() => {
      const c = this.cur();
      const no = c?.no ?? -1;
      if (no === this.roundNo) return;
      this.roundNo = no;
      this.localLocked.set(false);
      this.frozen.set(null);
      const mine = this.state()?.myChoice;
      this.aimZone.set(mine?.zone ?? null);
      this.diveCol.set(mine?.col ?? null);
    });
    // A newly resolved kick: show its result.
    effect(() => {
      const st = this.state();
      if (!st) return;
      const n = st.history.length;
      if (this.seenKicks === -1) { this.seenKicks = n; return; }
      if (n > this.seenKicks) {
        this.seenKicks = n;
        this.revealed.set(st.history[n - 1]);
        this.revealedAt = Date.now();
      }
    });
    // When it's over, move on after the last result has been seen.
    effect(() => {
      if (this.state()?.done && !this.endTimer) {
        this.endTimer = setTimeout(() => this.finished.emit(), END_CARD_DELAY_MS + 4000);
      }
    });
  }

  ngOnInit() {
    void this.join();
    this.realtime.shootout$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => { if (s.code === this.code()) this.apply(s); });
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refresh());
    const poll = setInterval(() => { if (!document.hidden && !this.state()?.done) void this.refresh(); }, POLL_MS);
    const ticker = setInterval(() => this.onTick(), 200);
    this.destroyRef.onDestroy(() => { clearInterval(poll); clearInterval(ticker); });
    const onVisible = () => { if (!document.hidden) { void this.refresh(); this.clock.sync(true); } };
    document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
    this.raf = requestAnimationFrame(this.frame);
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    if (this.endTimer) clearTimeout(this.endTimer);
  }

  private onTick() {
    this.tick.set(Date.now());
    const r = this.revealed();
    const c = this.cur();
    const st = this.state();
    if (r) {
      if (st?.done) {
        // The final kick: let it play out, then the end card takes over.
        if (Date.now() - this.revealedAt > END_CARD_DELAY_MS) this.revealed.set(null);
      } else {
        const nextStarted = c && this.clock.precise() >= Date.parse(c.startsAt) && c.no > r.no;
        if (nextStarted || Date.now() - this.revealedAt > REVEAL_MAX_MS) this.revealed.set(null);
      }
    }
  }

  /** One animation-frame loop moves the timing bar's marker. No Angular change detection per frame. */
  private frame = (ts: number) => {
    const c = this.cur();
    const el = this.markerEl()?.nativeElement;
    const track = this.trackEl()?.nativeElement;
    if (el && track && c?.timing && c.role === 'KICKER') {
      let pos: number | null = null;
      const f = this.frozen();
      if (f !== null) pos = f;
      else if (!this.locked()) {
        const t = Math.max(0, this.clock.preciseAt(ts) - Date.parse(c.startsAt));
        pos = markerAt(c.timing.periodMs, c.timing.phase, t);
      }
      if (pos !== null) el.style.transform = `translate3d(${pos * track.clientWidth}px,0,0)`;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private apply(s: ShootoutState) {
    const cur = this.state();
    if (cur && Date.parse(s.serverNow) < Date.parse(cur.serverNow)) return; // an older response arriving late
    this.state.set(s);
  }

  async join() {
    this.error.set('');
    try {
      this.apply((await this.api.post<{ state: ShootoutState }>(`/matches/${this.code()}/live/join`)).state);
    } catch (err) {
      this.error.set(apiError(err).message);
    }
  }

  private async refresh() {
    try {
      this.apply((await this.api.get<{ state: ShootoutState }>(`/matches/${this.code()}/live`)).state);
    } catch { /* the next poll or push will catch up */ }
  }

  protected pick(z: number) {
    if (!this.canAct()) return;
    if (this.role() === 'KEEPER') this.diveCol.set(zoneCol(z)); else this.aimZone.set(z);
  }

  protected async act(ev: PointerEvent) {
    const c = this.cur();
    if (!c || !this.canAct()) return;
    this.busy.set(true);
    try {
      if (c.role === 'KICKER') {
        const zone = this.aimZone();
        if (zone === null || !c.timing) return;
        // The tap's own timestamp, not "when this handler ran", so a slow frame can't move the shot.
        const at = ev.timeStamp > 1e11 ? performance.now() : ev.timeStamp;
        const stopMs = Math.max(0, Math.round(this.clock.preciseAt(at) - Date.parse(c.startsAt)));
        this.frozen.set(markerAt(c.timing.periodMs, c.timing.phase, stopMs));
        this.localLocked.set(true);
        this.apply((await this.api.post<{ state: ShootoutState }>(`/matches/${this.code()}/live/kick`, { zone, stopMs })).state);
      } else {
        const col = this.diveCol();
        if (col === null) return;
        this.localLocked.set(true);
        this.apply((await this.api.post<{ state: ShootoutState }>(`/matches/${this.code()}/live/dive`, { col })).state);
      }
    } catch (err) {
      this.localLocked.set(false);
      this.frozen.set(null);
      this.toast.error(err);
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }
}
