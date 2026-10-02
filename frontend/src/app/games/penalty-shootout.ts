import { Component, ElementRef, OnDestroy, OnInit, computed, input, output, signal, viewChild } from '@angular/core';
import { GameFinish, sleep } from './game-types';

interface Shot { periodMs: number; phase: number; lean: 'LEFT' | 'CENTER' | 'RIGHT'; }
interface Spec { shots: Shot[]; maxShotMs: number; countdownMs: number; }

/** Same triangle-wave function the server uses to place the ball. */
export function markerAt(periodMs: number, phase: number, t: number) {
  const p = ((t / periodMs) + phase) % 1;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

/** A tap this soon after the marker appears is almost certainly left over from the previous shot. */
const MIN_SHOT_MS = 120;
const KEEPER_LEFT = { LEFT: 22, CENTER: 50, RIGHT: 78 } as const;

/**
 * Penalty shootout. Built to stay light on a phone: plain DOM and CSS (no
 * images, canvas or per-frame Angular updates). The marker moves by writing a
 * transform straight to the element once per animation frame, and the ball's
 * flight is a single CSS transition. Timing uses the tap event's own
 * timestamp, so a slow frame can't change where the shot lands.
 */
@Component({
  selector: 'app-penalty-shootout',
  template: `
    <div class="ps">
      <div class="ps-head">
        <div class="pips" aria-hidden="true">
          @for (taken of pips(); track $index) { <span class="pip" [class.taken]="taken"></span> }
        </div>
        <p class="ps-shot">Shot {{ shotNo() }} of {{ total() }}</p>
        <p class="ps-lean" [class.off]="phase() !== 'aim'">Keeper leans <strong>{{ leanLabel() }}</strong></p>
      </div>

      <div class="pitch" (pointerdown)="onTap($event)">
        <div class="goal" #goal>
          <i class="zone z1"></i><i class="zone z2"></i>
          <div class="keeper" [style.left.%]="keeperLeft()"><span class="k-head"></span><span class="k-body"></span></div>
          <div class="aim" #aim></div>
        </div>
        <div class="ball" #ball></div>
        <div class="overlay" aria-live="polite">
          @switch (phase()) {
            @case ('countdown') { <div class="count">{{ count() }}</div><div class="sub">Tap Shoot when the marker is where you want the ball.</div> }
            @case ('shot') { <div class="msg" [class.loss]="lastWide()">{{ lastWide() ? 'Wide' : 'Shot taken' }}</div> }
            @case ('done') { <div class="msg">Full time</div><div class="sub">Checking your shots</div> }
          }
        </div>
      </div>

      <button class="shoot" type="button" [disabled]="phase() !== 'aim'" (pointerdown)="onTap($event)">Shoot</button>
      <p class="clock">{{ phase() === 'aim' ? clock() + 's left on this shot' : '' }}</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ps { display: flex; flex-direction: column; gap: 12px; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
    .ps-head { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px; }
    .pips { display: flex; gap: 5px; }
    .pip { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-strong); }
    .pip.taken { background: var(--text); border-color: var(--text); }
    .ps-shot { font-family: var(--font-display); font-size: 22px; font-weight: 600; }
    .ps-lean { color: var(--text-2); font-size: 15px; text-align: right; }
    .ps-lean strong { color: var(--text); }
    .ps-lean.off { visibility: hidden; }

    .pitch { position: relative; height: min(52vh, 420px); min-height: 300px; background: #1b2e22; border-radius: var(--radius); overflow: hidden; contain: layout paint; cursor: pointer; }
    .goal { position: absolute; left: 8%; right: 8%; top: 10%; height: 42%; border: 5px solid #eceae3; border-bottom: 0; }
    .zone { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255, 255, 255, .16); }
    .z1 { left: 33.33%; } .z2 { left: 66.66%; }
    .keeper { position: absolute; bottom: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; transition: left .25s ease-out; }
    .k-head { width: 20px; height: 20px; border-radius: 50%; background: #d9b44a; }
    .k-body { width: 54px; height: 62px; margin-top: 2px; border-radius: 12px 12px 3px 3px; background: #cfd3c8; }
    .aim { position: absolute; top: -14px; bottom: 0; left: 0; width: 4px; margin-left: -2px; background: var(--accent); will-change: transform; visibility: hidden; }
    .aim.on { visibility: visible; }
    .ball { position: absolute; left: 50%; bottom: 9%; width: 24px; height: 24px; margin-left: -12px; border-radius: 50%; background: #fff; border: 3px solid #14100c; will-change: transform; }
    .ball.fly { transition: transform .28s ease-out; }

    .overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; padding: 0 16px 22%; text-align: center; pointer-events: none; }
    .count { font-family: var(--font-display); font-size: 88px; font-weight: 700; line-height: 1; color: var(--accent); }
    .msg { font-family: var(--font-display); font-size: 30px; font-weight: 700; }
    .sub { color: var(--text-2); font-size: 16px; }

    .shoot { min-height: 68px; border-radius: var(--radius); background: var(--accent); color: var(--accent-ink); font-family: var(--font-display); font-size: 28px; font-weight: 700; cursor: pointer; text-align: center; }
    .shoot:disabled { opacity: .35; cursor: default; }
    .clock { min-height: 22px; text-align: center; color: var(--muted); font-size: 15px; font-variant-numeric: tabular-nums; }
    @media (prefers-reduced-motion: reduce) { .keeper, .ball.fly { transition-duration: .001ms; } }
  `],
})
export class PenaltyShootoutGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();

  private goalEl = viewChild.required<ElementRef<HTMLElement>>('goal');
  private aimEl = viewChild.required<ElementRef<HTMLElement>>('aim');
  private ballEl = viewChild.required<ElementRef<HTMLElement>>('ball');

  protected phase = signal<'countdown' | 'aim' | 'shot' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected taken = signal<{ stopMs: number }[]>([]);
  protected clock = signal(0);
  protected lastWide = signal(false);

  protected total = computed(() => this.spec().shots.length);
  protected shotNo = computed(() => Math.min(this.index() + 1, this.total()));
  protected pips = computed(() => Array.from({ length: this.total() }, (_, i) => i < this.taken().length));
  private current = computed(() => this.spec().shots[Math.min(this.index(), this.total() - 1)]);
  protected leanLabel = computed(() => ({ LEFT: 'left', CENTER: 'centre', RIGHT: 'right' })[this.current().lean]);
  protected keeperLeft = computed(() => KEEPER_LEFT[this.current().lean]);

  private shotStart = 0;
  private goalW = 0;
  private raf = 0;
  private stopShot: ((stopMs: number) => void) | null = null;
  private destroyed = false;

  ngOnInit() { void this.run(); }
  ngOnDestroy() { this.destroyed = true; cancelAnimationFrame(this.raf); }

  private async run() {
    const spec = this.spec();
    const start = performance.now();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.shots.length; i++) {
      const stopMs = await this.playShot(i);
      if (this.destroyed) return;
      this.taken.update((l) => [...l, { stopMs }]);
      await this.kick(spec.shots[i], stopMs);
      if (this.destroyed) return;
    }
    this.phase.set('done');
    this.finished.emit({ actions: { shots: this.taken() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  /** Sweep the marker until the player shoots (or the shot clock runs out). Resolves with the stop time in ms. */
  private playShot(i: number) {
    const spec = this.spec();
    const shot = spec.shots[i];
    this.index.set(i);
    this.resetBall();
    this.goalW = this.goalEl().nativeElement.clientWidth;
    this.clock.set(Math.ceil(spec.maxShotMs / 1000));
    this.phase.set('aim');
    const aim = this.aimEl().nativeElement;
    aim.classList.add('on');
    let lastSec = this.clock();
    return new Promise<number>((resolve) => {
      this.stopShot = (ms) => { this.stopShot = null; cancelAnimationFrame(this.raf); aim.classList.remove('on'); resolve(ms); };
      const loop = (ts: number) => {
        if (!this.shotStart) this.shotStart = ts;
        const t = ts - this.shotStart;
        if (t >= spec.maxShotMs) { this.stopShot?.(spec.maxShotMs); return; }
        aim.style.transform = `translate3d(${markerAt(shot.periodMs, shot.phase, t) * this.goalW}px,0,0)`;
        const left = Math.ceil((spec.maxShotMs - t) / 1000);
        if (left !== lastSec) { lastSec = left; this.clock.set(left); }
        this.raf = requestAnimationFrame(loop);
      };
      this.shotStart = 0;
      this.raf = requestAnimationFrame(loop);
    });
  }

  /** Fly the ball to where the marker was, then pause briefly before the next shot. */
  private async kick(shot: Shot, stopMs: number) {
    const x = markerAt(shot.periodMs, shot.phase, stopMs);
    const wide = x < 0.05 || x > 0.95;
    this.lastWide.set(wide);
    this.phase.set('shot');
    const pitch = this.ballEl().nativeElement.parentElement as HTMLElement;
    const dx = (x - 0.5) * this.goalW;
    const dy = -pitch.clientHeight * (wide ? 0.8 : 0.52);
    const ball = this.ballEl().nativeElement;
    ball.classList.add('fly');
    ball.style.transform = `translate3d(${dx}px,${dy}px,0) scale(.72)`;
    await sleep(700);
  }

  private resetBall() {
    const ball = this.ballEl().nativeElement;
    ball.classList.remove('fly');
    ball.style.transform = 'translate3d(0,0,0)';
    this.aimEl().nativeElement.style.transform = 'translate3d(0,0,0)';
  }

  protected onTap(e: PointerEvent) {
    if (this.phase() !== 'aim' || !this.stopShot || !this.shotStart) return;
    // event.timeStamp shares performance.now()'s clock in current browsers; fall back if it is epoch-based.
    const at = e.timeStamp > 1e11 ? performance.now() : e.timeStamp;
    const stopMs = Math.round(at - this.shotStart);
    if (stopMs < MIN_SHOT_MS) return;
    e.preventDefault();
    this.stopShot(Math.min(stopMs, this.spec().maxShotMs));
  }
}
