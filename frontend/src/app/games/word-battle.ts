import { Component, computed, ElementRef, HostListener, input, OnDestroy, OnInit, output, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { GameFinish, sleep } from './game-types';
import { buzz, burst, flash, floatText, GameAudio, shake } from './game-fx';

interface Spec { words: { scrambled: string; length: number }[]; limitMs: number; countdownMs: number; }
interface Answer { answer: string; timeMs: number; }

const PURPLE = '#a855f7';

/**
 * Word Battle: eight scrambled words. Tap the letters in order to spell each one (no phone keyboard in the way),
 * then lock it in. The faster the right answer, the more it is worth. The words are checked by the server, so
 * the game can't tell you whether a word is right until the end. The same words for both players.
 */
@Component({
  selector: 'app-word-battle',
  imports: [MatIconModule],
  styleUrl: './game-hud.scss',
  template: `
    <div class="gx-top">
      <div class="gx-score"><span>Locked in</span><strong [class.bump]="bump()">{{ answeredCount() }}</strong></div>
      <div class="gx-mid"></div>
      <div class="gx-round"><span>Word</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
    </div>

    <div class="gx-arena wb" #arena style="--gx-glow: rgba(168, 85, 247, .15)">
      @switch (phase()) {
        @case ('countdown') {
          <div class="gx-center"><div class="gx-count">{{ count() }}</div><p class="gx-hint">Tap the letters in order to spell each word. Faster answers score more.</p></div>
        }
        @case ('done') {
          <div class="gx-center"><div class="gx-label">Finished</div><p class="gx-hint">Checking your answers…</p></div>
        }
        @default {
          <div class="timebar" [class.low]="timeLeft() <= 5"><i [style.width.%]="pct()"></i></div>
          <div class="seconds" [class.low]="timeLeft() <= 5">{{ timeLeft() }}</div>

          <div class="slots" #slotsEl>
            @for (s of slots(); track $index) {
              <button class="slot" [class.filled]="s !== ''" [class.locked]="phase() !== 'input'" [disabled]="phase() !== 'input' || s === ''" (pointerdown)="removeAt($index)">{{ s }}</button>
            }
          </div>

          <div class="pool">
            @for (i of order(); track i) {
              <button class="lt" [class.used]="picked().includes(i)" [disabled]="phase() !== 'input' || picked().includes(i)" (pointerdown)="pick(i)">{{ letters()[i] }}</button>
            }
          </div>

          <div class="tools">
            <button class="tool" type="button" [disabled]="phase() !== 'input'" (pointerdown)="shuffle()" aria-label="Shuffle the letters"><mat-icon>shuffle</mat-icon></button>
            <button class="tool" type="button" [disabled]="phase() !== 'input' || picked().length === 0" (pointerdown)="backspace()" aria-label="Delete a letter"><mat-icon>backspace</mat-icon></button>
            <button class="tool skip" type="button" [disabled]="phase() !== 'input'" (click)="skip()">Skip</button>
          </div>

          <button class="lock" type="button" [class.ready]="full()" [disabled]="phase() !== 'input' || !full()" (click)="lockIn()">
            @if (phase() === 'feedback') { {{ lastSkipped() ? 'Skipped' : 'Locked in' }} } @else { Lock in }
          </button>
        }
      }
    </div>
  `,
  styles: [`
    .wb { height: auto; min-height: 0; padding: 16px 14px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .wb > * { z-index: 2; }
    .timebar { width: 100%; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
    .timebar i { display: block; height: 100%; background: #a855f7; transition: width .2s linear, background .3s; }
    .timebar.low i { background: var(--loss); }
    .seconds { font-family: var(--font-display); font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; color: var(--text-2); }
    .seconds.low { color: var(--loss); }
    .slots { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; min-height: 58px; }
    .slot { width: 46px; height: 56px; border-radius: 10px; border: 2px dashed var(--border-strong); background: transparent; color: var(--text);
      font-family: var(--font-display); font-size: 30px; font-weight: 700; padding: 0; touch-action: manipulation; cursor: pointer; }
    .slot.filled { border-style: solid; border-color: #a855f7; background: rgba(168, 85, 247, .18); animation: put .14s ease-out; }
    .slot.locked { opacity: .8; }
    @keyframes put { from { transform: scale(.8); } to { transform: scale(1); } }
    .pool { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; max-width: 420px; }
    .lt { width: 52px; height: 60px; border-radius: 10px; border: 1px solid #7c3aed; background: linear-gradient(180deg, #8b5cf6, #6d28d9); color: #fff;
      font-family: var(--font-display); font-size: 30px; font-weight: 700; padding: 0; cursor: pointer; touch-action: manipulation; box-shadow: 0 3px 0 #4c1d95; transition: transform .06s, opacity .15s; }
    .lt:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 #4c1d95; }
    .lt.used { opacity: .18; box-shadow: none; }
    .tools { display: flex; gap: 10px; align-items: center; }
    .tool { height: 46px; min-width: 56px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-2); cursor: pointer; display: flex; align-items: center; justify-content: center; touch-action: manipulation; }
    .tool:disabled { opacity: .4; }
    .tool.skip { font-weight: 600; font-size: 16px; }
    .lock { width: min(100%, 420px); min-height: 60px; border-radius: var(--radius); border: 0; background: var(--surface-3); color: var(--muted); font-family: var(--font-display); font-size: 26px; font-weight: 700; cursor: pointer; transition: background .15s, color .15s, transform .08s; }
    .lock.ready { background: var(--accent); color: var(--accent-ink); }
    .lock.ready:active { transform: scale(.98); }
    .lock:disabled:not(.ready) { cursor: default; }
    @media (prefers-reduced-motion: reduce) { .slot.filled { animation: none; } }
  `],
})
export class WordBattleGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  private arena = viewChild.required<ElementRef<HTMLElement>>('arena');
  private audio = new GameAudio();

  protected phase = signal<'countdown' | 'input' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected answers = signal<Answer[]>([]);
  protected lastSkipped = signal(false);
  protected bump = signal(false);
  protected now = signal(0);
  /** Indices into the scrambled letters, in the order the player tapped them. */
  protected picked = signal<number[]>([]);
  /** The order the letters are laid out in; "shuffle" only changes this, never the word. */
  protected order = signal<number[]>([]);
  private wordStart = 0;
  private resolve: ((a: Answer) => void) | null = null;
  private destroyed = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastTickSecond = -1;

  protected total = computed(() => this.spec().words.length);
  protected current = computed(() => this.spec().words[Math.min(this.index(), this.total() - 1)]);
  protected letters = computed(() => this.current().scrambled.split(''));
  protected slots = computed(() => Array.from({ length: this.current().length }, (_, i) => (this.picked()[i] !== undefined ? this.letters()[this.picked()[i]] : '')));
  protected full = computed(() => this.picked().length === this.current().length);
  protected answeredCount = computed(() => this.answers().filter((a) => a.answer).length);
  protected elapsed = computed(() => (this.phase() === 'input' ? this.now() - this.wordStart : 0));
  protected timeLeft = computed(() => Math.max(0, Math.ceil((this.spec().limitMs - this.elapsed()) / 1000)));
  protected pct = computed(() => Math.max(0, 100 - (this.elapsed() / this.spec().limitMs) * 100));

  ngOnInit() { this.ticker = setInterval(() => this.tickClock(), 200); this.run(); }
  ngOnDestroy() { this.destroyed = true; clearInterval(this.ticker); }

  private tickClock() {
    this.now.set(performance.now());
    if (this.phase() !== 'input') return;
    const left = this.timeLeft();
    if (left <= 3 && left > 0 && left !== this.lastTickSecond) { this.lastTickSecond = left; this.audio.tick(); }
  }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); this.audio.tick(); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.words.length; i++) {
      this.index.set(i);
      this.picked.set([]);
      this.order.set(Array.from({ length: spec.words[i].length }, (_, k) => k));
      this.lastTickSecond = -1;
      this.phase.set('input');
      this.wordStart = performance.now();
      this.now.set(this.wordStart);
      const a = await new Promise<Answer>((resolve) => {
        const t = setTimeout(() => { this.resolve = null; resolve({ answer: this.currentGuess(), timeMs: spec.limitMs }); }, spec.limitMs);
        this.resolve = (x) => { clearTimeout(t); this.resolve = null; resolve(x); };
      });
      if (this.destroyed) return;
      this.answers.update((l) => [...l, a]);
      this.lastSkipped.set(!a.answer);
      this.phase.set('feedback');
      this.celebrate(!!a.answer);
      await sleep(550);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { words: this.answers() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  private currentGuess() {
    return this.picked().length === this.current().length ? this.picked().map((i) => this.letters()[i]).join('').toLowerCase() : '';
  }

  private celebrate(locked: boolean) {
    const host = this.arena().nativeElement;
    const box = host.getBoundingClientRect();
    if (locked) {
      this.audio.hit(0.7);
      burst(host, box.width / 2, 110, PURPLE, 12);
      floatText(host, box.width / 2, 100, 'Locked in', '#c4b5fd', 22);
      this.bump.set(true); setTimeout(() => this.bump.set(false), 320);
      buzz(14);
    } else {
      this.audio.miss();
    }
  }

  protected pick(i: number) {
    if (this.phase() !== 'input' || this.picked().includes(i) || this.full()) return;
    this.audio.unlock();
    this.audio.tap(this.picked().length);
    buzz(6);
    this.picked.update((p) => [...p, i]);
  }

  protected removeAt(slot: number) {
    if (this.phase() !== 'input') return;
    this.audio.tap(0);
    this.picked.update((p) => p.filter((_, k) => k !== slot));
  }

  protected backspace() {
    if (this.phase() !== 'input') return;
    this.audio.tap(0);
    this.picked.update((p) => p.slice(0, -1));
  }

  protected shuffle() {
    if (this.phase() !== 'input') return;
    this.audio.unlock();
    this.audio.tap(3);
    this.order.update((o) => {
      const a = [...o];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    });
  }

  protected lockIn() {
    if (this.phase() !== 'input' || !this.full()) return;
    this.audio.unlock();
    this.resolve?.({ answer: this.currentGuess(), timeMs: Math.round(performance.now() - this.wordStart) });
  }

  protected skip() {
    if (this.phase() !== 'input') return;
    shake(this.arena().nativeElement);
    flash(this.arena().nativeElement, '#6b7280', 0.18);
    this.resolve?.({ answer: '', timeMs: Math.round(performance.now() - this.wordStart) });
  }

  /** Desktop: type the letters, Backspace to undo, Enter to lock in. */
  @HostListener('window:keydown', ['$event'])
  protected onKey(ev: KeyboardEvent) {
    if (this.phase() !== 'input' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Backspace') { ev.preventDefault(); this.backspace(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); this.lockIn(); return; }
    if (ev.key.length === 1 && /[a-z]/i.test(ev.key)) {
      const ch = ev.key.toUpperCase();
      const idx = this.order().find((i) => this.letters()[i] === ch && !this.picked().includes(i));
      if (idx !== undefined) { ev.preventDefault(); this.pick(idx); }
    }
  }
}
