import { Component, computed, input, OnDestroy, OnInit, output, signal } from '@angular/core';
import { GameFinish, sleep } from './game-types';

interface Spec { grid: number; rounds: { sequence: number[] }[]; flashMs: number; gapMs: number; inputLimitMs: number; countdownMs: number; }
interface RoundInput { input: number[]; timeMs: number; }

@Component({
  selector: 'app-memory-battle',
  styleUrl: './game-hud.scss',
  template: `
    <div class="hud">
      <div class="hud-item"><span>Round</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
      <div class="hud-item"><span>Length</span><strong>{{ seqLen() }}</strong></div>
      <div class="hud-item"><span>Correct</span><strong>{{ correct() }}</strong></div>
      <div class="hud-item"><span>Time</span><strong>{{ timeLeft() }}</strong></div>
    </div>
    <div class="board-wrap">
      <div class="status">
        @switch (phase()) {
          @case ('countdown') { <span class="count-sm">{{ count() }}</span> Get ready to memorise… }
          @case ('show') { <span class="muted">Watch the sequence…</span> }
          @case ('input') { Your turn — repeat the sequence ({{ entered().length }}/{{ seqLen() }}) }
          @case ('feedback') { <span [class.win]="lastOk()" [class.loss]="!lastOk()">{{ lastOk() ? 'Correct!' : 'Not quite' }}</span> }
          @case ('done') { Finished! Submitting… }
        }
      </div>
      <div class="board" [style.grid-template-columns]="'repeat(' + spec().grid + ', 1fr)'">
        @for (c of cells(); track c) {
          <button class="cell" [class.lit]="lit() === c" [class.tap]="tapped() === c" [disabled]="phase() !== 'input'" (pointerdown)="tap(c)"></button>
        }
      </div>
    </div>
  `,
  styles: [`
    .board-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 16px; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-elev); }
    .status { min-height: 28px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .count-sm { font-family: var(--font-display); color: var(--accent); font-size: 22px; }
    .board { display: grid; gap: 10px; width: min(100%, 420px); aspect-ratio: 1; }
    .cell { border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer; transition: background .08s, transform .08s; touch-action: manipulation; }
    .cell:disabled { cursor: default; }
    .cell.lit { background: var(--accent); box-shadow: 0 0 24px rgba(200,255,61,.45); border-color: var(--accent); }
    .cell.tap { background: #f97316; transform: scale(.96); }
  `],
})
export class MemoryBattleGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  protected phase = signal<'countdown' | 'show' | 'input' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected lit = signal<number | null>(null);
  protected tapped = signal<number | null>(null);
  protected entered = signal<number[]>([]);
  protected results = signal<RoundInput[]>([]);
  protected lastOk = signal(false);
  protected deadline = signal(0);
  protected now = signal(0);
  protected total = computed(() => this.spec().rounds.length);
  protected cells = computed(() => Array.from({ length: this.spec().grid ** 2 }, (_, i) => i));
  protected seqLen = computed(() => this.spec().rounds[Math.min(this.index(), this.total() - 1)].sequence.length);
  protected correct = computed(() => this.results().filter((r, i) => this.isCorrect(r.input, i)).length);
  protected timeLeft = computed(() => (this.phase() === 'input' ? `${Math.max(0, Math.ceil((this.deadline() - this.now()) / 1000))}s` : '—'));
  private inputStart = 0;
  private resolve: (() => void) | null = null;
  private destroyed = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  ngOnInit() { this.ticker = setInterval(() => this.now.set(performance.now()), 200); this.run(); }
  ngOnDestroy() { this.destroyed = true; clearInterval(this.ticker); }

  private isCorrect(input: number[], i: number) {
    const seq = this.spec().rounds[i].sequence;
    return input.length === seq.length && input.every((c, j) => c === seq[j]);
  }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.rounds.length; i++) {
      this.index.set(i);
      this.phase.set('show');
      await sleep(400);
      for (const cell of spec.rounds[i].sequence) {
        this.lit.set(cell); await sleep(spec.flashMs);
        this.lit.set(null); await sleep(spec.gapMs);
        if (this.destroyed) return;
      }
      this.entered.set([]);
      this.phase.set('input');
      this.inputStart = performance.now();
      this.deadline.set(this.inputStart + spec.inputLimitMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.resolve = null; resolve(); }, spec.inputLimitMs);
        this.resolve = () => { clearTimeout(t); this.resolve = null; resolve(); };
      });
      if (this.destroyed) return;
      const timeMs = Math.round(performance.now() - this.inputStart);
      this.results.update((r) => [...r, { input: this.entered(), timeMs }]);
      this.lastOk.set(this.isCorrect(this.entered(), i));
      this.phase.set('feedback');
      await sleep(700);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { rounds: this.results() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  protected tap(cell: number) {
    if (this.phase() !== 'input') return;
    this.tapped.set(cell);
    setTimeout(() => this.tapped.set(null), 120);
    this.entered.update((e) => [...e, cell]);
    const seq = this.spec().rounds[this.index()].sequence;
    const e = this.entered();
    // End the round when complete or on the first wrong tile.
    if (e.length >= seq.length || e[e.length - 1] !== seq[e.length - 1]) this.resolve?.();
  }
}
