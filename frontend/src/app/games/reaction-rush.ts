import { Component, computed, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { GameFinish, nextPaint, sleep } from './game-types';

interface Round { delayMs: number; x: number; y: number; size: number; }
interface Spec { rounds: Round[]; windowMs: number; countdownMs: number; interRoundMs: number; }
interface RoundResult { hit: boolean; reactionMs: number | null; falseStart?: boolean; }

/** Mirrors the server formula for instant feedback. The server score is authoritative. */
const pointsFor = (rt: number) => Math.min(1000, Math.max(100, Math.round(1100 - rt * 0.8)));

@Component({
  selector: 'app-reaction-rush',
  styleUrl: './game-hud.scss',
  template: `
    <div class="hud">
      <div class="hud-item"><span>Round</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
      <div class="hud-item"><span>Score</span><strong>{{ score() }}</strong></div>
      <div class="hud-item"><span>Last</span><strong>{{ last() }}</strong></div>
      <div class="hud-item"><span>Average</span><strong>{{ avg() }}</strong></div>
    </div>
    <div class="arena" (pointerdown)="arenaDown()">
      @if (phase() === 'countdown') {
        <div class="overlay"><div class="count" [attr.data-n]="count()">{{ count() }}</div><div class="sub">Tap the target the moment it appears</div></div>
      }
      @if (phase() === 'wait') {
        <div class="overlay"><div class="msg muted">Wait for it…</div></div>
      }
      @if (phase() === 'target') {
        <button class="target" [style.left.%]="current().x" [style.top.%]="current().y" [style.width.px]="current().size" [style.height.px]="current().size"
                (pointerdown)="hit($event)" aria-label="Target"></button>
      }
      @if (phase() === 'feedback') {
        <div class="overlay">
          <div class="msg" [class.win]="feedback().good" [class.loss]="!feedback().good">{{ feedback().title }}</div>
          <div class="sub">{{ feedback().sub }}</div>
        </div>
      }
      @if (phase() === 'done') {
        <div class="overlay"><div class="msg">Finished!</div><div class="sub">Checking your result…</div></div>
      }
    </div>
    <div class="progress">
      @for (r of results(); track $index) { <i [class.hit]="r.hit" [class.miss]="!r.hit"></i> }
      @for (i of remaining(); track $index) { <i [class.cur]="$first && phase() !== 'countdown'"></i> }
    </div>
  `,
  styles: [`
    .target {
      position: absolute; transform: translate(-50%, -50%); border-radius: 50%; border: 0; padding: 0; cursor: pointer; z-index: 2;
      background: radial-gradient(circle, #14100c 0 18%, var(--accent) 19% 38%, #14100c 39% 50%, var(--accent) 51% 100%);
      box-shadow: 0 0 0 4px rgba(245,112,31,.2), 0 0 30px rgba(245,112,31,.35);
      animation: appear .09s ease-out both; touch-action: manipulation;
    }
    @keyframes appear { from { transform: translate(-50%, -50%) scale(.6); } to { transform: translate(-50%, -50%) scale(1); } }
  `],
})
export class ReactionRushGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;

  protected phase = signal<'countdown' | 'wait' | 'target' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected results = signal<RoundResult[]>([]);
  protected feedback = signal({ title: '', sub: '', good: true });
  protected total = computed(() => this.spec().rounds.length);
  protected current = computed(() => this.spec().rounds[Math.min(this.index(), this.total() - 1)]);
  protected remaining = computed(() => Array.from({ length: this.total() - this.results().length }));
  protected score = computed(() => this.results().reduce((a, r) => a + (r.hit && r.reactionMs ? pointsFor(r.reactionMs) : 0), 0));
  protected last = computed(() => {
    const r = this.results().at(-1);
    return !r ? '-' : r.hit ? `${r.reactionMs}ms` : r.falseStart ? 'Early' : 'Miss';
  });
  protected avg = computed(() => {
    const hits = this.results().filter((r) => r.hit);
    return hits.length ? `${Math.round(hits.reduce((a, r) => a + (r.reactionMs ?? 0), 0) / hits.length)}ms` : '-';
  });

  private startedAt = 0;
  private shownAt = 0;
  private resolveRound: ((r: RoundResult) => void) | null = null;
  private destroyed = false;

  ngOnInit() { this.run(); }
  ngOnDestroy() { this.destroyed = true; }

  private async run() {
    this.startedAt = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) {
      this.count.set(c);
      await sleep(1000);
      if (this.destroyed) return;
    }
    for (let i = 0; i < spec.rounds.length; i++) {
      this.index.set(i);
      const result = await this.playRound(spec.rounds[i], spec.windowMs);
      if (this.destroyed) return;
      this.results.update((r) => [...r, result]);
      this.feedback.set(
        result.hit
          ? { title: `${result.reactionMs} ms`, sub: `+${pointsFor(result.reactionMs!)} points`, good: true }
          : result.falseStart ? { title: 'Too early!', sub: 'Wait for the target, 0 points', good: false } : { title: 'Missed', sub: '0 points', good: false },
      );
      this.phase.set('feedback');
      await sleep(spec.interRoundMs);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { rounds: this.results() }, clientElapsedMs: Math.round(performance.now() - this.startedAt) });
  }

  private playRound(round: Round, windowMs: number): Promise<RoundResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: RoundResult) => { if (!settled) { settled = true; this.resolveRound = null; clearTimeout(timer); clearTimeout(timeout); resolve(r); } };
      this.resolveRound = settle;
      this.phase.set('wait');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(async () => {
        if (settled) return;
        this.phase.set('target');
        this.shownAt = await nextPaint();
        timeout = setTimeout(() => settle({ hit: false, reactionMs: null }), windowMs);
      }, round.delayMs);
    });
  }

  protected hit(ev: PointerEvent) {
    ev.stopPropagation();
    if (this.phase() !== 'target' || !this.resolveRound || !this.shownAt) return;
    const rt = Math.round(performance.now() - this.shownAt);
    this.shownAt = 0;
    this.resolveRound({ hit: true, reactionMs: rt });
  }

  protected arenaDown() {
    // Tapping before the target appears is a false start.
    if (this.phase() === 'wait' && this.resolveRound) this.resolveRound({ hit: false, reactionMs: null, falseStart: true });
  }
}
