import { Component, computed, ElementRef, input, OnDestroy, OnInit, output, signal, viewChild } from '@angular/core';
import { GameFinish, sleep } from './game-types';
import { buzz, burst, floatText, flash, GameAudio, shake } from './game-fx';

interface Spec { grid: number; rounds: { sequence: number[] }[]; flashMs: number; gapMs: number; inputLimitMs: number; countdownMs: number; }
interface RoundInput { input: number[]; timeMs: number; }

/** Four colours, one per quarter of the board, so a sequence is easier to chunk in your head. */
const QUARTER = ['#22d3ee', '#f5701f', '#a855f7', '#34d399'];
const SCALE = [262, 294, 330, 392, 440];
const note = (cell: number) => SCALE[cell % 5] * (1 + Math.floor(cell / 5) * 0.5);

/** Mirrors the server formula for instant feedback. The server score is authoritative. */
function pointsFor(seq: number[], entered: number[], timeMs: number) {
  const len = seq.length;
  const correct = entered.length === len && entered.every((c, j) => c === seq[j]);
  if (correct) return len * 100 + Math.max(0, Math.min(300, Math.round(300 - timeMs / len / 8)));
  let prefix = 0;
  while (prefix < entered.length && entered[prefix] === seq[prefix]) prefix++;
  return prefix * 20;
}

/**
 * Memory Battle: watch a pattern of tiles light up, then repeat it. Each tile has its own colour and note, so you can
 * remember it by ear as well. Eight rounds, each longer than the last. The same patterns for both players.
 */
@Component({
  selector: 'app-memory-battle',
  styleUrl: './game-hud.scss',
  template: `
    <div class="gx-top">
      <div class="gx-score"><span>Score</span><strong [class.bump]="bump()">{{ score() }}</strong></div>
      <div class="gx-mid"></div>
      <div class="gx-round"><span>Round</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
    </div>

    <div class="gx-arena mem" #arena style="--gx-glow: rgba(245, 112, 31, .14)">
      <div class="status">
        @switch (phase()) {
          @case ('countdown') { <span class="gx-hint">Watch the tiles, then repeat them in the same order.</span> }
          @case ('show') { <span class="state">Watch</span> }
          @case ('input') { <span class="state go">Your turn</span> }
          @case ('feedback') { <span class="state" [class.gx-good]="lastOk()" [class.gx-bad]="!lastOk()">{{ lastOk() ? 'Perfect' : 'Not quite' }}</span> }
          @case ('done') { <span class="gx-hint">Checking your result…</span> }
        }
      </div>

      <div class="dots" [class.hide]="phase() === 'countdown' || phase() === 'done'">
        @for (d of dots(); track $index) { <i [class.on]="$index < progress()" [class.bad]="wrongAt() === $index"></i> }
      </div>

      <div class="board" #board [style.grid-template-columns]="'repeat(' + spec().grid + ', 1fr)'">
        @for (c of cells(); track c) {
          <button class="cell" [style.--c]="colour(c)" [class.lit]="lit() === c" [class.tap]="tapped() === c" [class.ok]="okCell() === c"
                  [disabled]="phase() !== 'input'" (pointerdown)="tap(c)" [attr.aria-label]="'Tile ' + (c + 1)"></button>
        }
      </div>

      @if (phase() === 'countdown') { <div class="gx-center count-over"><div class="gx-count">{{ count() }}</div></div> }
      @if (phase() === 'input') { <div class="timer"><i [style.width.%]="timePct()"></i></div> }
    </div>
  `,
  styles: [`
    .mem { height: auto; min-height: 0; padding: 16px 14px 14px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .status { min-height: 36px; display: flex; align-items: center; z-index: 2; }
    .state { font-family: var(--font-display); font-size: 30px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .state.go { color: var(--accent); }
    .dots { display: flex; gap: 6px; z-index: 2; min-height: 12px; flex-wrap: wrap; justify-content: center; }
    .dots.hide { visibility: hidden; }
    .dots i { width: 12px; height: 12px; border-radius: 50%; background: var(--surface-3); transition: background .15s, transform .15s; }
    .dots i.on { background: var(--win); transform: scale(1.15); }
    .dots i.bad { background: var(--loss); }
    .board { display: grid; gap: 8px; width: min(100%, 440px); aspect-ratio: 1; z-index: 2; }
    .cell { --c: #22d3ee; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); background: color-mix(in srgb, var(--c) 14%, #151a17);
      cursor: pointer; transition: background .08s, transform .08s, box-shadow .08s; touch-action: manipulation; padding: 0; }
    .cell:disabled { cursor: default; }
    .cell.lit { background: var(--c); box-shadow: 0 0 28px color-mix(in srgb, var(--c) 70%, transparent); border-color: var(--c); transform: scale(1.04); }
    .cell.tap { background: color-mix(in srgb, var(--c) 70%, #fff 10%); transform: scale(.95); }
    .cell.ok { box-shadow: 0 0 0 3px var(--win), 0 0 18px rgba(92, 203, 138, .5); }
    .timer { width: min(100%, 440px); height: 5px; border-radius: 3px; background: var(--surface-3); overflow: hidden; z-index: 2; }
    .timer i { display: block; height: 100%; background: var(--accent); transition: width .2s linear; }
    .count-over { background: rgba(10, 13, 11, .78); z-index: 5; }
    @media (prefers-reduced-motion: reduce) { .cell, .dots i { transition: none; } }
  `],
})
export class MemoryBattleGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  private arena = viewChild.required<ElementRef<HTMLElement>>('arena');
  private board = viewChild.required<ElementRef<HTMLElement>>('board');
  private audio = new GameAudio();

  protected phase = signal<'countdown' | 'show' | 'input' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected lit = signal<number | null>(null);
  protected tapped = signal<number | null>(null);
  protected okCell = signal<number | null>(null);
  protected entered = signal<number[]>([]);
  protected shown = signal(0);
  protected wrongAt = signal<number | null>(null);
  protected results = signal<RoundInput[]>([]);
  protected lastOk = signal(false);
  protected bump = signal(false);
  protected deadline = signal(0);
  protected now = signal(0);
  protected total = computed(() => this.spec().rounds.length);
  protected cells = computed(() => Array.from({ length: this.spec().grid ** 2 }, (_, i) => i));
  protected seq = computed(() => this.spec().rounds[Math.min(this.index(), this.total() - 1)].sequence);
  protected dots = computed(() => Array.from({ length: this.seq().length }));
  /** Dots filled: tiles shown so far while watching, tiles you have got right while repeating. */
  protected progress = computed(() => (this.phase() === 'show' ? this.shown() : this.phase() === 'input' || this.phase() === 'feedback' ? this.goodTaps() : 0));
  protected goodTaps = computed(() => {
    const s = this.seq(); const e = this.entered();
    let n = 0;
    while (n < e.length && e[n] === s[n]) n++;
    return n;
  });
  protected score = computed(() => this.results().reduce((a, r, i) => a + pointsFor(this.spec().rounds[i].sequence, r.input, r.timeMs), 0));
  protected timePct = computed(() => Math.max(0, ((this.deadline() - this.now()) / this.spec().inputLimitMs) * 100));
  private inputStart = 0;
  private resolve: (() => void) | null = null;
  private destroyed = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  ngOnInit() { this.ticker = setInterval(() => this.now.set(performance.now()), 150); this.run(); }
  ngOnDestroy() { this.destroyed = true; clearInterval(this.ticker); }

  protected colour(cell: number) {
    const spec = this.spec();
    const half = spec.grid / 2;
    const row = Math.floor(cell / spec.grid); const col = cell % spec.grid;
    return QUARTER[(row >= half ? 2 : 0) + (col >= half ? 1 : 0)];
  }

  private isCorrect(input: number[], i: number) {
    const seq = this.spec().rounds[i].sequence;
    return input.length === seq.length && input.every((c, j) => c === seq[j]);
  }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); this.audio.tick(); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.rounds.length; i++) {
      this.index.set(i);
      this.entered.set([]);
      this.wrongAt.set(null);
      this.shown.set(0);
      this.phase.set('show');
      await sleep(550);
      for (const cell of spec.rounds[i].sequence) {
        this.lit.set(cell);
        this.audio.note(note(cell), spec.flashMs / 1000);
        await sleep(spec.flashMs);
        this.lit.set(null);
        this.shown.update((n) => n + 1);
        await sleep(spec.gapMs);
        if (this.destroyed) return;
      }
      this.audio.go();
      this.phase.set('input');
      this.inputStart = performance.now();
      this.now.set(this.inputStart);
      this.deadline.set(this.inputStart + spec.inputLimitMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.resolve = null; resolve(); }, spec.inputLimitMs);
        this.resolve = () => { clearTimeout(t); this.resolve = null; resolve(); };
      });
      if (this.destroyed) return;
      const timeMs = Math.round(performance.now() - this.inputStart);
      this.results.update((r) => [...r, { input: this.entered(), timeMs }]);
      const ok = this.isCorrect(this.entered(), i);
      this.lastOk.set(ok);
      this.phase.set('feedback');
      if (ok) {
        this.audio.hit(1);
        const box = this.board().nativeElement.getBoundingClientRect(); const host = this.arena().nativeElement.getBoundingClientRect();
        burst(this.arena().nativeElement, box.left - host.left + box.width / 2, box.top - host.top + box.height / 2, '#5ccb8a', 18);
        floatText(this.arena().nativeElement, box.left - host.left + box.width / 2, box.top - host.top + box.height / 2, `+${pointsFor(spec.rounds[i].sequence, this.entered(), timeMs)}`, '#5ccb8a', 34);
        this.bump.set(true); setTimeout(() => this.bump.set(false), 320);
        buzz([14, 30, 14]);
      }
      await sleep(ok ? 950 : 800);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { rounds: this.results() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  protected tap(cell: number) {
    if (this.phase() !== 'input') return;
    this.audio.unlock();
    const seq = this.seq();
    const pos = this.entered().length;
    this.entered.update((e) => [...e, cell]);
    this.tapped.set(cell);
    setTimeout(() => this.tapped.set(null), 130);
    const host = this.arena().nativeElement;
    if (cell === seq[pos]) {
      this.audio.note(note(cell), 0.2);
      this.okCell.set(cell);
      setTimeout(() => this.okCell.set(null), 160);
      buzz(8);
      if (pos + 1 >= seq.length) this.resolve?.();
    } else {
      // The first wrong tile ends the round.
      this.wrongAt.set(pos);
      this.audio.wrong();
      shake(this.board().nativeElement);
      flash(host, '#ef4444', 0.25);
      buzz([40, 30, 40]);
      this.resolve?.();
    }
  }
}
