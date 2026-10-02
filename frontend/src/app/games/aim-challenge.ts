import { Component, computed, ElementRef, input, OnDestroy, OnInit, output, signal, viewChild } from '@angular/core';
import { GameFinish, nextPaint, sleep } from './game-types';
import { buzz, burst, floatText, GameAudio, ripple } from './game-fx';

interface Target { x: number; y: number; size: number; }
interface Spec { targets: Target[]; lifetimeMs: number; gapMs: number; countdownMs: number; }
interface Shot { hit: boolean; reactionMs?: number; offset?: number; }

const RED = '#ef4444';
const GOLD = '#facc15';

/** Mirrors the server formula for instant feedback. The server score is authoritative. */
const pointsFor = (rt: number, offset: number) => Math.max(50, Math.min(600, Math.round(600 - (rt - 150) * 0.5))) + Math.round((1 - offset) * 100) * 4;
const grade = (offset: number) => (offset < 0.18 ? { label: 'Bullseye', color: GOLD, q: 1 } : offset < 0.45 ? { label: 'Great', color: '#5ccb8a', q: 0.7 } : offset < 0.75 ? { label: 'Good', color: '#e8ece8', q: 0.45 } : { label: 'Edge', color: '#f0805a', q: 0.2 });

/**
 * Aim Challenge: twenty targets, one after another, each shrinking away. Tap close to the centre, and quickly:
 * speed and accuracy both score. The same twenty targets, in the same places, for both players.
 */
@Component({
  selector: 'app-aim-challenge',
  styleUrl: './game-hud.scss',
  template: `
    <div class="gx-top">
      <div class="gx-score"><span>Score</span><strong [class.bump]="bump()">{{ score() }}</strong></div>
      <div class="gx-mid">@if (streak() >= 2) { <span class="gx-streak">{{ streak() }} hits in a row</span> }</div>
      <div class="gx-round"><span>Target</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
    </div>

    <div class="gx-arena" #arena style="--gx-glow: rgba(239, 68, 68, .14)">
      @if (phase() === 'countdown') {
        <div class="gx-center">
          <div class="gx-count">{{ count() }}</div>
          <p class="gx-hint">Tap each target before it shrinks away. Aim for the centre.</p>
        </div>
      }
      @if (phase() === 'target') {
        <button class="t" [style.left]="edge(current().x, current().size + 12)" [style.top]="edge(current().y, current().size + 12)" [style.width.px]="current().size + 12" [style.height.px]="current().size + 12"
                [style.animation-duration.ms]="spec().lifetimeMs" (pointerdown)="shoot($event)" aria-label="Target"></button>
      }
      @if (phase() === 'done') { <div class="gx-center"><div class="gx-label">Finished</div><div class="gx-hint">Checking your result…</div></div> }
    </div>

    <div class="gx-pips">
      @for (s of shots(); track $index) { <i [class.hit]="s.hit" [class.miss]="!s.hit"></i> }
      @for (i of remaining(); track $index) { <i></i> }
    </div>
  `,
  styles: [`
    .t { position: absolute; transform: translate(-50%, -50%) scale(1); border-radius: 50%; border: 0; padding: 0; cursor: crosshair; z-index: 4; touch-action: manipulation;
      background: radial-gradient(circle, #facc15 0 9%, #ef4444 10% 26%, #fff 27% 42%, #ef4444 43% 62%, #fff 63% 80%, #ef4444 81% 100%);
      box-shadow: 0 0 0 3px rgba(239, 68, 68, .25), 0 0 26px rgba(239, 68, 68, .4);
      animation-name: shrink; animation-timing-function: linear; animation-fill-mode: forwards; }
    @keyframes shrink { from { transform: translate(-50%, -50%) scale(1.15); } to { transform: translate(-50%, -50%) scale(.28); opacity: .55; } }
    @media (prefers-reduced-motion: reduce) { .t { animation-name: fade; } @keyframes fade { to { opacity: .4; } } }
  `],
})
export class AimChallengeGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  private arena = viewChild.required<ElementRef<HTMLElement>>('arena');
  private audio = new GameAudio();

  protected phase = signal<'countdown' | 'target' | 'gap' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected shots = signal<Shot[]>([]);
  protected streak = signal(0);
  protected bump = signal(false);
  protected total = computed(() => this.spec().targets.length);
  protected current = computed(() => this.spec().targets[Math.min(this.index(), this.total() - 1)]);
  protected remaining = computed(() => Array.from({ length: this.total() - this.shots().length }));
  protected score = computed(() => this.shots().reduce((a, s) => a + (s.hit && s.reactionMs != null ? pointsFor(s.reactionMs, s.offset ?? 1) : 0), 0));
  private shownAt = 0;
  private resolve: ((s: Shot) => void) | null = null;
  private destroyed = false;

  ngOnInit() { this.run(); }
  ngOnDestroy() { this.destroyed = true; }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); this.audio.tick(); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.targets.length; i++) {
      this.index.set(i);
      const shot = await new Promise<Shot>(async (resolve) => {
        let done = false;
        const settle = (s: Shot) => { if (!done) { done = true; this.resolve = null; clearTimeout(t); resolve(s); } };
        this.phase.set('target');
        this.shownAt = await nextPaint();
        this.audio.pop();
        this.resolve = settle;
        const t = setTimeout(() => settle({ hit: false }), spec.lifetimeMs);
      });
      if (this.destroyed) return;
      this.shots.update((s) => [...s, shot]);
      if (!shot.hit) this.onMiss(spec.targets[i]);
      this.phase.set('gap');
      await sleep(spec.gapMs);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { targets: this.shots() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  /** Keeps a target fully inside the arena, whatever the screen size. */
  protected edge(pct: number, size: number) {
    const r = size / 2 + 6;
    return `clamp(${r}px, ${pct}%, calc(100% - ${r}px))`;
  }

  private pos(t: Target) {
    const box = this.arena().nativeElement.getBoundingClientRect();
    const r = (t.size + 12) / 2 + 6;
    return { x: Math.min(box.width - r, Math.max(r, (t.x / 100) * box.width)), y: Math.min(box.height - r, Math.max(r, (t.y / 100) * box.height)) };
  }

  private onMiss(t: Target) {
    this.streak.set(0);
    const { x, y } = this.pos(t);
    ripple(this.arena().nativeElement, x, y, '#6b7280', 50);
    floatText(this.arena().nativeElement, x, y, 'Missed', '#9ca3af', 20);
    this.audio.miss();
  }

  protected shoot(ev: PointerEvent) {
    ev.stopPropagation();
    this.audio.unlock();
    if (!this.resolve) return;
    const rect = (ev.target as HTMLElement).getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // The ring shrinks over time, so measure against the size it has now.
    const offset = Math.min(1, Math.hypot(ev.clientX - cx, ev.clientY - cy) / (rect.width / 2));
    const rt = Math.round(performance.now() - this.shownAt);
    const o = Math.round(offset * 1000) / 1000;

    const host = this.arena().nativeElement;
    const box = host.getBoundingClientRect();
    const g = grade(o);
    const px = ev.clientX - box.left; const py = ev.clientY - box.top;
    this.streak.update((n) => n + 1);
    this.bump.set(true);
    setTimeout(() => this.bump.set(false), 320);
    burst(host, px, py, g.color, g.q > 0.9 ? 16 : 9);
    ripple(host, px, py, g.color);
    floatText(host, px, py - 14, g.label === 'Bullseye' ? `Bullseye +${pointsFor(rt, o)}` : `+${pointsFor(rt, o)}`, g.color, g.label === 'Bullseye' ? 26 : 22);
    this.audio.hit(g.q);
    if (this.streak() >= 4) this.audio.streak(this.streak());
    buzz(g.q > 0.9 ? [12, 20, 12] : 12);

    this.resolve({ hit: true, reactionMs: rt, offset: o });
  }
}
