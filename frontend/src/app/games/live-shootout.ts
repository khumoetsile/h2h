import { Component, DestroyRef, ElementRef, HostListener, OnDestroy, OnInit, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { Countdown } from '../shared/countdown';
import { Api } from '../core/api.service';
import { apiError } from '../core/api-error';
import { RealtimeService } from '../core/realtime.service';
import { ServerClock } from '../core/server-clock';
import { Toast } from '../core/toast.service';
import { ShootoutAudio } from './shootout-audio';
import { ShootoutScene } from './shootout-scene';
import { PERFECT_BAND, ShootoutKick, ShootoutState, markerAt, zoneCol } from './shootout.model';

type Pip = 'goal' | 'saved' | 'miss' | 'now' | 'todo';

/** After the final kick has played, how long before the end card is allowed to cover the pitch. */
const END_AUTO_MS = 9000;
const DEFAULT_AIM = 4;
/** How many choices this phone has made. The first couple of kicks get a fuller hint; after that it stays short. */
const ACTS_KEY = 'h2h.shootout.acts';
const COACHED_ACTS = 2;
const POLL_MS = 2500;

/**
 * Live penalty shootout screen. The server runs the rules and keeps every
 * choice sealed until both players are in; this screen sends your own choice
 * and shows what the server tells it, through the animated stage.
 *
 * Built to stay light on a phone: plain DOM/SVG and CSS, no images or canvas,
 * no per-frame Angular updates (the timing gauge's marker is moved with a
 * transform from a single animation-frame loop), and this component is its
 * own lazy chunk.
 */
function readActs() {
  try { return Number(localStorage.getItem(ACTS_KEY)) || 0; } catch { return 0; }
}

@Component({
  selector: 'app-live-shootout',
  imports: [MatIconModule, ShootoutScene, Countdown],
  template: `
    @if (error()) {
      <div class="err"><p>{{ error() }}</p><button class="btn btn-primary" (click)="join()">Try again</button></div>
    } @else if (state(); as st) {
      <div class="so">
        <section class="board" aria-label="Score">
          <div class="rows">
            @for (s of sides(); track s.userId) {
              <div class="side" [class.me]="s.me">
                <i class="kit"></i>
                <span class="name">{{ s.me ? 'You' : s.username }}</span>
                <span class="pips">@for (p of s.pips; track $index) { <i class="pip" [attr.data-s]="p"></i> }</span>
                <strong class="goals">{{ s.goals }}</strong>
              </div>
            }
          </div>
          <button class="snd" type="button" (pointerdown)="toggleSound($event)" [attr.aria-label]="muted() ? 'Turn sound on' : 'Turn sound off'">
            <mat-icon>{{ muted() ? 'volume_off' : 'volume_up' }}</mat-icon>
          </button>
        </section>

        <p class="status" aria-live="polite">
          {{ status() }}
          @if (st.suddenDeath && !st.done) { <span class="tag">Sudden death</span> }
          @if (secondsLeft() !== null) { <span class="clock" [class.hurry]="secondsLeft()! <= 3">{{ secondsLeft() }}s</span> }
          @if (st.phase === 'LOBBY' && st.lobbyDeadline) { <span class="clock"><app-countdown [deadline]="st.lobbyDeadline" [icon]="false" /></span> }
        </p>

        <div class="stage">
          <app-shootout-scene #scene
            [mode]="revealed() ? null : role()" [interactive]="canAct()" [aimZone]="aimZone()" [diveZone]="diveZone()"
            [youKick]="youKick()" [countdown]="countdownNum()" [caption]="caption()" [audio]="audio"
            (pickZone)="pickZone($event)" (pickDive)="pickDive($event)" (contact)="onContact()" />
          @if (st.done && !revealed()) {
            <div class="end" [attr.data-w]="st.winnerId === st.viewerId ? 'win' : st.winnerId === null ? 'draw' : 'loss'">
              <h2>{{ endTitle() }}</h2>
              <p>{{ endSub() }}</p>
              <button class="btn btn-primary btn-lg" (click)="finished.emit()">See result</button>
            </div>
          }
        </div>

        @if (role() === 'KICKER' && !st.done && !revealed()) {
          <div class="gauge" [class.dim]="!canAct() && frozen() === null" (pointerdown)="act($event)">
            <div class="track" #track>
              <i class="b-low"></i><i class="b-high"></i><i class="b-perfect"></i>
              <i class="marker" #marker></i>
            </div>
            <div class="legend"><span>Weak</span><span>Good</span><strong>Perfect</strong><span>Good</span><span>Weak</span></div>
          </div>
        }

        @if (!st.done) {
          @if (role() === 'KICKER') {
            <button class="act" type="button" [disabled]="!canAct()" (pointerdown)="act($event)">Shoot</button>
          }
          <p class="hint" [class.big]="role() === 'KEEPER'">{{ hint() }}</p>
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

    .board { display: flex; align-items: stretch; gap: 8px; background: var(--surface); border-radius: var(--radius); padding: 8px 8px 8px 14px; }
    .rows { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; justify-content: center; }
    .side { display: grid; grid-template-columns: 12px minmax(0, 7em) 1fr auto; align-items: center; gap: 10px; }
    .kit { width: 12px; height: 12px; border-radius: 3px; background: #6fa8dc; }
    .side.me .kit { background: #f5701f; }
    .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pips { display: flex; gap: 6px; flex-wrap: wrap; }
    .pip { width: 15px; height: 15px; border-radius: 50%; border: 2px solid var(--border-strong); box-sizing: border-box; transition: background .2s, border-color .2s; }
    .pip { position: relative; }
    .pip[data-s='goal'] { background: var(--win); border-color: var(--win); }
    .pip[data-s='goal']::after { content: ''; position: absolute; left: 3px; top: 1px; width: 4px; height: 7px; border: solid #0e1a12; border-width: 0 2px 2px 0; transform: rotate(40deg); }
    .pip[data-s='saved'] { background: var(--loss); border-color: var(--loss); }
    .pip[data-s='saved']::before, .pip[data-s='saved']::after { content: ''; position: absolute; left: 50%; top: 50%; width: 8px; height: 2px; margin: -1px 0 0 -4px; background: #1c0f0d; transform: rotate(45deg); }
    .pip[data-s='saved']::after { transform: rotate(-45deg); }
    .pip[data-s='miss'] { background: var(--muted); border-color: var(--muted); }
    .pip[data-s='miss']::after { content: ''; position: absolute; left: 50%; top: 50%; width: 7px; height: 2px; margin: -1px 0 0 -3.5px; background: #1a1d1b; }
    .pip[data-s='now'] { border-color: var(--text); animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .35; } }
    .goals { font-family: var(--font-display); font-size: 30px; line-height: 1; min-width: 1ch; text-align: right; }
    .snd { align-self: flex-start; width: 36px; height: 36px; border-radius: 4px; color: var(--text-2); display: flex; align-items: center; justify-content: center; }
    .snd:hover { background: var(--surface-2); color: var(--text); }

    .status { min-height: 24px; text-align: center; color: var(--text-2); font-size: 17px; }
    .tag { margin-left: 8px; background: var(--demo-soft); color: var(--demo); border-radius: 3px; padding: 1px 7px; font-size: 14px; font-weight: 600; }
    .clock { margin-left: 8px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .clock.hurry { color: var(--loss); font-weight: 700; }

    .stage { position: relative; }
    .end { position: absolute; inset: 0; border-radius: var(--radius); background: rgba(16, 19, 17, .9); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px; animation: fade .35s ease both; }
    .end h2 { font-size: 54px; line-height: 1; }
    .end[data-w='win'] h2 { color: var(--win); } .end[data-w='loss'] h2 { color: var(--loss); }
    .end p { color: var(--text-2); font-size: 18px; margin-bottom: 8px; }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    .gauge.dim { opacity: .55; }
    .track { position: relative; height: 44px; background: #2a302b; border-radius: 4px; overflow: hidden; }
    .track i { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); }
    /* Band widths are twice the server's half-widths: low 0.40, high 0.25, perfect 0.09. */
    .b-low { width: 80%; background: #34403a; }
    .b-high { width: 50%; background: #3c6b4a; }
    .b-perfect { width: 18%; background: var(--win); transition: filter .1s; }
    .track.perfect .b-perfect { filter: brightness(1.35); }
    .marker { left: 0 !important; width: 6px; margin-left: -3px; background: #fff; border-radius: 2px; will-change: transform; }
    .legend { display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 5px; color: var(--muted); font-size: 13px; text-align: center; }
    .legend strong { color: var(--win); font-weight: 600; }

    .act { min-height: 68px; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); font-family: var(--font-display); font-size: 30px; font-weight: 700; cursor: pointer; text-align: center; transition: transform .08s; }
    .act:active:not(:disabled) { transform: scale(.985); }
    .act:disabled { opacity: .35; cursor: default; }
    @media (orientation: landscape) and (max-height: 540px) {
      /* Sideways phone: the pitch is sized by the height we have, controls sit beside it. */
      .so { max-width: none; display: grid; grid-template-columns: auto minmax(220px, 1fr); gap: 6px 16px; align-items: start; justify-content: center; }
      .stage { grid-column: 1; grid-row: 1 / span 6; height: calc(100vh - 92px); aspect-ratio: 360 / 400; }
      .so > :not(.stage) { grid-column: 2; }
      .side { grid-template-columns: 12px minmax(0, 5em) 1fr auto; }
      .hint { font-size: 14px; }
    }
    .hint { text-align: center; color: var(--muted); font-size: 15px; min-height: 20px; }
    .hint.big { color: var(--text); font-size: 19px; font-weight: 600; padding: 6px 0 14px; }
    .help { display: flex; flex-direction: column; gap: 12px; max-width: 520px; margin: 0 auto; padding: 8px 0 24px; }
    .help h2 { font-size: 30px; }
    .help p { font-size: 18px; line-height: 1.45; color: var(--text-2); }
    .help strong { color: var(--text); }
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

  protected audio = new ShootoutAudio();
  protected muted = signal(this.audio.muted);
  private scene = viewChild(ShootoutScene);
  private trackEl = viewChild<ElementRef<HTMLElement>>('track');
  private markerEl = viewChild<ElementRef<HTMLElement>>('marker');

  private acts = signal(readActs());
  protected state = signal<ShootoutState | null>(null);
  protected error = signal('');
  protected aimZone = signal<number | null>(null);
  protected diveZone = signal<number | null>(null);
  protected frozen = signal<number | null>(null); // marker position kept after the kicker has shot
  protected revealed = signal<ShootoutKick | null>(null);
  /** The kick being replayed: its result is held back from the scoreboard until the ball arrives. */
  private pending = signal<ShootoutKick | null>(null);
  private revealedAt = 0;
  private localLocked = signal(false);
  private busy = signal(false);
  protected tick = signal(Date.now());
  private seenKicks = -1;
  private roundNo = -1;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private inPerfect = false;
  private lastCount: number | null = null;

  private cur = computed(() => this.state()?.current ?? null);
  protected role = computed(() => this.cur()?.role ?? null);
  private nowMs = computed(() => { this.tick(); return this.clock.precise(); });
  private opp = computed(() => this.state()?.players.find((p) => p.userId !== this.state()!.viewerId) ?? null);

  /** Kit colours follow whoever is shooting: the kick being replayed, else the one being taken. */
  protected youKick = computed(() => {
    const r = this.revealed();
    const st = this.state();
    if (r && st) return r.kickerId === st.viewerId;
    return this.cur() ? this.cur()!.role === 'KICKER' : true;
  });

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

  /** 3, 2, 1 shown on the pitch before a kick. */
  protected countdownNum = computed(() => {
    const c = this.cur(); const st = this.state();
    if (!c || !st || st.done || this.revealed()) return null;
    const n = Math.ceil((Date.parse(c.startsAt) - this.nowMs()) / 1000);
    return n >= 1 && n <= 3 ? n : null;
  });

  protected sides = computed(() => {
    const st = this.state();
    if (!st) return [];
    const hold = this.pending();
    const shown = hold ? st.history.filter((k) => k.no !== hold.no) : st.history;
    const nowKicker = hold ? hold.kickerId : st.done ? null : st.current?.kickerId ?? null;
    return st.players.map((p) => {
      const kicks = shown.filter((k) => k.kickerId === p.userId);
      const pips: Pip[] = kicks.map((k) => (k.outcome === 'GOAL' ? 'goal' : k.outcome === 'SAVED' ? 'saved' : 'miss'));
      if (nowKicker === p.userId) pips.push('now');
      while (pips.length < st.kicksPerSide) pips.push('todo');
      return { userId: p.userId, username: p.username, me: p.userId === st.viewerId, pips, goals: kicks.filter((k) => k.outcome === 'GOAL').length };
    });
  });

  protected status = computed(() => {
    const st = this.state();
    if (!st) return '';
    if (st.done) return 'Shootout over';
    if (st.phase === 'LOBBY') return `Waiting for ${this.opp()?.username ?? 'your opponent'} to take the pitch`;
    const c = st.current;
    if (!c) return '';
    if (this.revealed()) return '';
    const toStart = Math.ceil((Date.parse(c.startsAt) - this.nowMs()) / 1000);
    if (toStart > 0) return `Kick ${c.no}: ${c.role === 'KICKER' ? 'you shoot' : 'you keep goal'}`;
    if (this.locked()) return c.opponentLocked ? 'Both locked in' : `Locked in. Waiting for ${this.opp()?.username ?? 'your opponent'}`;
    if (c.opponentLocked) return `${this.opp()?.username ?? 'Your opponent'} has chosen. Your turn`;
    return c.role === 'KEEPER' ? 'Your dive' : 'Your shot';
  });

  /** Over the pitch while the next kick counts down. */
  protected caption = computed(() => {
    const c = this.cur();
    if (!c || this.revealed() || this.state()?.done || this.countdownNum() === null) return null;
    return c.role === 'KICKER' ? 'You shoot' : 'You keep goal';
  });

  protected hint = computed(() => {
    const c = this.cur();
    if (!c || this.revealed() || this.state()?.done || this.locked()) return '';
    const coached = this.acts() < COACHED_ACTS;
    if (c.role === 'KEEPER') return coached ? 'Tap where you think they will shoot. High or low matters. You only save the exact spot.' : 'Tap the spot you think they will shoot at';
    return coached ? '1. Tap a spot to aim.  2. Tap Shoot when the marker is in the green.' : 'Tap the goal to change your aim. Tap Shoot when the marker is in the green';
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
      this.scene()?.reset();
      const mine = this.state()?.myChoice;
      // The kicker starts with the bottom-centre spot chosen, so a first-timer can just tap Shoot.
      this.aimZone.set(mine?.zone ?? (c?.role === 'KICKER' ? DEFAULT_AIM : null));
      this.diveZone.set(mine?.zone ?? null);
    });
    // A newly resolved kick: play it out on the stage.
    effect(() => {
      const st = this.state();
      if (!st) return;
      const n = st.history.length;
      if (this.seenKicks === -1) { this.seenKicks = n; return; }
      if (n > this.seenKicks) {
        this.seenKicks = n;
        const kick = st.history[n - 1];
        this.revealed.set(kick);
        this.pending.set(kick);
        this.warnIfDecidedForMe(kick, st);
        this.revealedAt = Date.now();
        void this.replay(kick, st);
      }
    });
    // Tick on the last second of the pre-kick countdown.
    effect(() => {
      const n = this.countdownNum();
      if (n !== null && n !== this.lastCount) this.audio.tick();
      this.lastCount = n;
    });
    // Whatever happens, move on from the end card after a while.
    effect(() => {
      if (this.state()?.done && !this.endTimer) this.endTimer = setTimeout(() => this.finished.emit(), END_AUTO_MS);
    });
  }

  ngOnInit() {
    void this.join();
    this.realtime.shootout$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => { if (s.code === this.code()) this.apply(s); });
    this.realtime.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refresh());
    const poll = setInterval(() => { if (!document.hidden && !this.state()?.done) void this.refresh(); }, POLL_MS);
    const ticker = setInterval(() => this.tick.set(Date.now()), 200);
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

  protected onContact() { this.pending.set(null); }

  /** Time ran out on one of my decisions: tell me plainly, and that two in a row forfeits. */
  private warnIfDecidedForMe(kick: ShootoutKick, st: ShootoutState) {
    const mine = (kick.kickerId === st.viewerId && kick.kickerAuto) || (kick.keeperId === st.viewerId && kick.keeperAuto);
    if (!mine || st.done) return;
    this.toast.info(kick.kickerId === st.viewerId
      ? 'You ran out of time, so that kick was missed. Miss one more in a row and you forfeit.'
      : 'You ran out of time, so your dive was picked for you. Miss one more in a row and you forfeit.');
  }

  /** Desktop: arrow keys move your aim (or dive), Space or Enter shoots. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent) {
    if (!this.canAct() || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const role = this.role();
    const key = ev.key;
    if (role === 'KEEPER') {
      const z = this.diveZone() ?? DEFAULT_AIM;
      let next: number | null = null;
      if (key === 'ArrowLeft') next = z - (z % 3 === 0 ? 0 : 1);
      else if (key === 'ArrowRight') next = z + (z % 3 === 2 ? 0 : 1);
      else if (key === 'ArrowUp') next = z % 3;
      else if (key === 'ArrowDown') next = 3 + (z % 3);
      else if (key === ' ' || key === 'Enter') { ev.preventDefault(); if (this.diveZone() !== null) void this.act(null); return; }
      if (next === null) return;
      ev.preventDefault();
      this.diveZone.set(next);
      return;
    }
    if (role !== 'KICKER') return;
    const z = this.aimZone() ?? DEFAULT_AIM;
    let next = z;
    if (key === 'ArrowLeft') next = z - (z % 3 === 0 ? 0 : 1);
    else if (key === 'ArrowRight') next = z + (z % 3 === 2 ? 0 : 1);
    else if (key === 'ArrowUp') next = z % 3;
    else if (key === 'ArrowDown') next = 3 + (z % 3);
    else if (key === ' ' || key === 'Enter') { ev.preventDefault(); void this.act(ev); return; }
    else return;
    ev.preventDefault();
    this.aimZone.set(next);
  }

  /** Browsers only allow sound after a tap. Any press on this screen unlocks it. */
  @HostListener('pointerdown') unlockAudio() { this.audio.unlock(); }

  private noteAct() {
    const n = this.acts() + 1;
    this.acts.set(n);
    try { localStorage.setItem(ACTS_KEY, String(n)); } catch { /* storage unavailable */ }
  }

  protected toggleSound(ev: Event) {
    ev.stopPropagation();
    this.audio.unlock();
    this.audio.setMuted(!this.audio.muted);
    this.muted.set(this.audio.muted);
  }

  private async replay(kick: ShootoutKick, st: ShootoutState) {
    const scene = this.scene();
    if (!scene) { this.pending.set(null); this.revealed.set(null); return; }
    await scene.play({ zone: kick.zone, keeperZone: kick.keeperZone, outcome: kick.outcome, quality: kick.quality, meKicker: kick.kickerId === st.viewerId });
    if (this.pending() === kick) this.pending.set(null);
    if (this.revealed() === kick) this.revealed.set(null);
    const now = this.state();
    if (now?.done && kick.no === now.history.length) {
      if (now.winnerId === now.viewerId) { scene.celebrate(); this.audio.win(); }
    }
  }

  /** One animation-frame loop moves the gauge's marker. No Angular change detection per frame. */
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
      if (pos !== null) {
        el.style.transform = `translate3d(${pos * track.clientWidth}px,0,0)`;
        const perfect = Math.abs(pos - 0.5) <= PERFECT_BAND;
        if (perfect !== this.inPerfect) { this.inPerfect = perfect; track.classList.toggle('perfect', perfect); }
      }
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
      const e = apiError(err);
      // Already over (e.g. you came back after a forfeit): nothing to join, go and see how it ended.
      if (['MATCH_COMPLETED', 'MATCH_CANCELLED', 'MATCH_VOID'].includes(e.code)) { this.finished.emit(); return; }
      this.error.set(e.message);
    }
  }

  private async refresh() {
    try {
      this.apply((await this.api.get<{ state: ShootoutState }>(`/matches/${this.code()}/live`)).state);
    } catch { /* the next poll or push will catch up */ }
  }

  protected pickZone(z: number) {
    if (!this.canAct() || this.role() !== 'KICKER') return;
    this.aimZone.set(z);
    this.audio.buzz(8);
  }

  /** For the keeper, tapping a spot in the goal is the whole decision: dive straight away. */
  protected pickDive(z: number) {
    if (!this.canAct() || this.role() !== 'KEEPER') return;
    this.diveZone.set(z);
    void this.act(null);
  }

  protected async act(ev: PointerEvent | KeyboardEvent | null) {
    const c = this.cur();
    if (!c || !this.canAct()) return;
    this.audio.unlock();
    this.busy.set(true);
    try {
      this.noteAct();
      if (c.role === 'KICKER') {
        const zone = this.aimZone();
        if (zone === null || !c.timing) return;
        // The tap's own timestamp, not "when this handler ran", so a slow frame can't move the shot.
        const at = !ev || ev.timeStamp > 1e11 ? performance.now() : ev.timeStamp;
        const stopMs = Math.max(0, Math.round(this.clock.preciseAt(at) - Date.parse(c.startsAt)));
        this.frozen.set(markerAt(c.timing.periodMs, c.timing.phase, stopMs));
        this.localLocked.set(true);
        this.audio.buzz(20);
        this.apply((await this.api.post<{ state: ShootoutState }>(`/matches/${this.code()}/live/kick`, { zone, stopMs })).state);
      } else {
        const zone = this.diveZone();
        if (zone === null) return;
        this.localLocked.set(true);
        this.audio.buzz(20);
        this.apply((await this.api.post<{ state: ShootoutState }>(`/matches/${this.code()}/live/dive`, { zone })).state);
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
