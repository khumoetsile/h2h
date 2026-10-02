import { Component, computed, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { GameFinish, sleep } from './game-types';

interface Shot { periodMs: number; phase: number; lean: 'LEFT' | 'CENTER' | 'RIGHT'; }
interface Spec { shots: Shot[]; maxShotMs: number; countdownMs: number; }

/** Same triangle-wave function the server uses to place the ball. */
export function markerAt(periodMs: number, phase: number, t: number) {
  const p = ((t / periodMs) + phase) % 1;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

@Component({
  selector: 'app-penalty-shootout',
  styleUrl: './game-hud.scss',
  template: `
    <div class="hud">
      <div class="hud-item"><span>Shot</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
      <div class="hud-item"><span>Keeper leans</span><strong>{{ phase() === 'aim' ? leanLabel() : '-' }}</strong></div>
      <div class="hud-item"><span>Shot clock</span><strong>{{ clock() }}s</strong></div>
    </div>
    <div class="pitch" (pointerdown)="shoot()">
      <div class="goal">
        <div class="net"></div>
        <div class="zone-lines"><i></i><i></i></div>
        <div class="keeper" [class.lean-left]="current().lean === 'LEFT'" [class.lean-right]="current().lean === 'RIGHT'">
          <span class="head"></span><span class="body"></span>
        </div>
        @if (phase() === 'aim') { <div class="marker" [style.left.%]="marker() * 100"></div> }
        @if (phase() === 'shot') { <div class="ball-in" [style.left.%]="lastX() * 100" [class.wide]="lastWide()"></div> }
      </div>
      <div class="spot"></div>
      <div class="overlay">
        @switch (phase()) {
          @case ('countdown') { <div class="count">{{ count() }}</div><div class="sub">Tap to shoot when the marker is where you want the ball</div> }
          @case ('aim') { <div class="hint">Tap anywhere to shoot</div> }
          @case ('shot') { <div class="msg" [class.loss]="lastWide()">{{ lastWide() ? 'Wide!' : 'Shot taken!' }}</div><div class="sub">{{ lastWide() ? 'Off target' : 'Result revealed at full time' }}</div> }
          @case ('done') { <div class="msg">Full time!</div><div class="sub">Checking your shots…</div> }
        }
      </div>
    </div>
    <div class="progress">
      @for (s of shots(); track $index) { <i class="cur"></i> }
      @for (i of remaining(); track $index) { <i></i> }
    </div>
  `,
  styles: [`
    .pitch { position: relative; height: min(62vh, 520px); min-height: 340px; border-radius: var(--radius-lg); overflow: hidden; cursor: pointer; user-select: none; touch-action: manipulation;
      border: 1px solid var(--border-strong);
      background: repeating-linear-gradient(180deg, #0f2a1d 0 48px, #0d2419 48px 96px); }
    .goal { position: absolute; left: 8%; right: 8%; top: 12%; height: 40%; border: 6px solid #e8ecf3; border-bottom: 0; border-radius: 4px 4px 0 0; }
    .net { position: absolute; inset: 0; background:
      linear-gradient(rgba(255,255,255,.12) 1px, transparent 1px) 0 0 / 16px 16px,
      linear-gradient(90deg, rgba(255,255,255,.12) 1px, transparent 1px) 0 0 / 16px 16px; }
    .zone-lines { position: absolute; inset: 0; display: flex; justify-content: space-evenly; pointer-events: none;
      i { width: 1px; border-left: 1px dashed rgba(255,255,255,.18); } }
    .keeper { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; transition: transform .2s;
      .head { width: 22px; height: 22px; border-radius: 50%; background: #fbbf24; }
      .body { width: 60px; height: 70px; border-radius: 14px 14px 4px 4px; background: #f97316; margin-top: 2px; } }
    .keeper.lean-left { transform: translateX(-70%) rotate(-12deg); }
    .keeper.lean-right { transform: translateX(-30%) rotate(12deg); }
    .marker { position: absolute; top: -18px; bottom: -6px; width: 4px; margin-left: -2px; background: var(--accent); box-shadow: 0 0 14px var(--accent); border-radius: 2px; }
    .ball-in { position: absolute; top: 40%; width: 26px; height: 26px; margin-left: -13px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px #111 inset; animation: kick .35s ease-out both; }
    .ball-in.wide { top: -20%; }
    @keyframes kick { from { transform: translateY(260px) scale(1.6); } to { transform: none; } }
    .spot { position: absolute; left: 50%; bottom: 14%; width: 26px; height: 26px; margin-left: -13px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px #111 inset; }
    .hint { position: absolute; bottom: 24px; color: var(--text-2); font-weight: 600; font-size: 13px; }
  `],
})
export class PenaltyShootoutGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  protected phase = signal<'countdown' | 'aim' | 'shot' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected shots = signal<{ stopMs: number }[]>([]);
  protected t = signal(0);
  protected lastX = signal(0.5);
  protected total = computed(() => this.spec().shots.length);
  protected current = computed(() => this.spec().shots[Math.min(this.index(), this.total() - 1)]);
  protected remaining = computed(() => Array.from({ length: this.total() - this.shots().length }));
  protected marker = computed(() => markerAt(this.current().periodMs, this.current().phase, this.t()));
  protected clock = computed(() => Math.max(0, Math.ceil((this.spec().maxShotMs - this.t()) / 1000)));
  protected leanLabel = computed(() => ({ LEFT: 'Left', CENTER: 'Centre', RIGHT: 'Right' })[this.current().lean]);
  protected lastWide = computed(() => this.lastX() < 0.05 || this.lastX() > 0.95);
  private shotStart = 0;
  private raf = 0;
  private resolve: ((stopMs: number) => void) | null = null;
  private destroyed = false;

  ngOnInit() { this.run(); }
  ngOnDestroy() { this.destroyed = true; cancelAnimationFrame(this.raf); }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.shots.length; i++) {
      this.index.set(i);
      this.phase.set('aim');
      this.shotStart = performance.now();
      const stopMs = await new Promise<number>((resolve) => {
        this.resolve = (ms) => { this.resolve = null; cancelAnimationFrame(this.raf); resolve(ms); };
        const loop = () => {
          const t = performance.now() - this.shotStart;
          if (t >= spec.maxShotMs) { this.t.set(spec.maxShotMs); this.resolve?.(spec.maxShotMs); return; }
          this.t.set(t);
          this.raf = requestAnimationFrame(loop);
        };
        loop();
      });
      if (this.destroyed) return;
      const s = spec.shots[i];
      this.lastX.set(markerAt(s.periodMs, s.phase, stopMs));
      this.shots.update((l) => [...l, { stopMs }]);
      this.phase.set('shot');
      await sleep(1100);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { shots: this.shots() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  protected shoot() {
    if (this.phase() !== 'aim' || !this.resolve) return;
    this.resolve(Math.round(performance.now() - this.shotStart));
  }
}
