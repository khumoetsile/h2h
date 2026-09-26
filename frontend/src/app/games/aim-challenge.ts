import { Component, computed, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { GameFinish, nextPaint, sleep } from './game-types';

interface Target { x: number; y: number; size: number; }
interface Spec { targets: Target[]; lifetimeMs: number; gapMs: number; countdownMs: number; }
interface Shot { hit: boolean; reactionMs?: number; offset?: number; }

@Component({
  selector: 'app-aim-challenge',
  styleUrl: './game-hud.scss',
  template: `
    <div class="hud">
      <div class="hud-item"><span>Target</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
      <div class="hud-item"><span>Hits</span><strong>{{ hits() }}</strong></div>
      <div class="hud-item"><span>Accuracy</span><strong>{{ accuracy() }}</strong></div>
      <div class="hud-item"><span>Last</span><strong>{{ last() }}</strong></div>
    </div>
    <div class="arena">
      @if (phase() === 'countdown') {
        <div class="overlay"><div class="count">{{ count() }}</div><div class="sub">Hit each target before it shrinks away — aim for the centre</div></div>
      }
      @if (phase() === 'target') {
        <button class="t" [style.left.%]="current().x" [style.top.%]="current().y" [style.width.px]="current().size" [style.height.px]="current().size"
                [style.animation-duration.ms]="spec().lifetimeMs" (pointerdown)="shoot($event)" aria-label="Target"></button>
      }
      @if (phase() === 'done') { <div class="overlay"><div class="msg">Finished!</div><div class="sub">Submitting your run…</div></div> }
    </div>
    <div class="progress">
      @for (s of shots(); track $index) { <i [class.hit]="s.hit" [class.miss]="!s.hit"></i> }
      @for (i of remaining(); track $index) { <i></i> }
    </div>
  `,
  styles: [`
    .t { position: absolute; transform: translate(-50%, -50%) scale(1); border-radius: 50%; border: 0; padding: 0; cursor: crosshair; z-index: 2;
      background: radial-gradient(circle, #fff 0 10%, var(--loss) 11% 30%, #fff 31% 45%, var(--loss) 46% 70%, #fff 71% 100%);
      animation-name: shrink; animation-timing-function: linear; animation-fill-mode: forwards; touch-action: manipulation; }
    @keyframes shrink { from { transform: translate(-50%, -50%) scale(1); } to { transform: translate(-50%, -50%) scale(.25); opacity: .6; } }
  `],
})
export class AimChallengeGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  protected phase = signal<'countdown' | 'target' | 'gap' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected shots = signal<Shot[]>([]);
  protected total = computed(() => this.spec().targets.length);
  protected current = computed(() => this.spec().targets[Math.min(this.index(), this.total() - 1)]);
  protected remaining = computed(() => Array.from({ length: this.total() - this.shots().length }));
  protected hits = computed(() => this.shots().filter((s) => s.hit).length);
  protected accuracy = computed(() => (this.shots().length ? `${Math.round((this.hits() / this.shots().length) * 100)}%` : '—'));
  protected last = computed(() => { const s = this.shots().at(-1); return !s ? '—' : s.hit ? `${s.reactionMs}ms` : 'Miss'; });
  private shownAt = 0;
  private resolve: ((s: Shot) => void) | null = null;
  private destroyed = false;

  ngOnInit() { this.run(); }
  ngOnDestroy() { this.destroyed = true; }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.targets.length; i++) {
      this.index.set(i);
      const shot = await new Promise<Shot>(async (resolve) => {
        let done = false;
        const settle = (s: Shot) => { if (!done) { done = true; this.resolve = null; clearTimeout(t); resolve(s); } };
        this.phase.set('target');
        this.shownAt = await nextPaint();
        this.resolve = settle;
        const t = setTimeout(() => settle({ hit: false }), spec.lifetimeMs);
      });
      if (this.destroyed) return;
      this.shots.update((s) => [...s, shot]);
      this.phase.set('gap');
      await sleep(spec.gapMs);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { targets: this.shots() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  protected shoot(ev: PointerEvent) {
    ev.stopPropagation();
    if (!this.resolve) return;
    const rect = (ev.target as HTMLElement).getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const offset = Math.min(1, Math.hypot(ev.clientX - cx, ev.clientY - cy) / (rect.width / 2));
    this.resolve({ hit: true, reactionMs: Math.round(performance.now() - this.shownAt), offset: Math.round(offset * 1000) / 1000 });
  }
}
