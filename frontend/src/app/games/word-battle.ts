import { Component, computed, ElementRef, input, OnDestroy, OnInit, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GameFinish, sleep } from './game-types';

interface Spec { words: { scrambled: string; length: number }[]; limitMs: number; countdownMs: number; }
interface Answer { answer: string; timeMs: number; }

@Component({
  selector: 'app-word-battle',
  imports: [FormsModule],
  styleUrl: './game-hud.scss',
  template: `
    <div class="hud">
      <div class="hud-item"><span>Word</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
      <div class="hud-item"><span>Answered</span><strong>{{ answeredCount() }}</strong></div>
      <div class="hud-item"><span>Time left</span><strong>{{ timeLeft() }}s</strong></div>
    </div>
    <div class="wb">
      @switch (phase()) {
        @case ('countdown') { <div class="count">{{ count() }}</div><p class="sub">Unscramble each word. Faster answers earn more points.</p> }
        @case ('done') { <div class="msg">Finished!</div><p class="sub">The server is checking your answers…</p> }
        @default {
          <div class="tiles-row">
            @for (ch of letters(); track $index) { <span class="lt">{{ ch }}</span> }
          </div>
          <div class="timebar"><i [style.width.%]="pct()"></i></div>
          <form class="answer" (ngSubmit)="submit()">
            <input #box [(ngModel)]="guess" name="guess" autocomplete="off" autocapitalize="characters" spellcheck="false"
                   [maxlength]="current().length" [disabled]="phase() !== 'input'" placeholder="Type the word…" />
            <button class="btn btn-primary" type="submit" [disabled]="phase() !== 'input' || !guess.trim()">Submit</button>
            <button class="btn btn-ghost" type="button" [disabled]="phase() !== 'input'" (click)="skip()">Skip</button>
          </form>
          @if (phase() === 'feedback') { <p class="sub">{{ lastSkipped() ? 'Skipped' : 'Answer locked in ✓' }}</p> }
        }
      }
    </div>
  `,
  styles: [`
    .wb { min-height: 340px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 24px 16px;
      border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-elev); text-align: center; }
    .tiles-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .lt { width: 48px; height: 56px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--surface-2);
      border: 1px solid var(--border-strong); font-family: var(--font-display); font-size: 28px; font-weight: 700; color: #c4b5fd; }
    .timebar { width: min(100%, 420px); height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden;
      i { display: block; height: 100%; background: #a855f7; transition: width .2s linear; } }
    .answer { display: flex; gap: 8px; width: min(100%, 460px); flex-wrap: wrap; justify-content: center;
      input { flex: 1; min-width: 180px; height: 46px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
        padding: 0 14px; font-size: 20px; font-family: var(--font-display); letter-spacing: .12em; text-transform: uppercase; outline: none;
        &:focus { border-color: #a855f7; } } }
  `],
})
export class WordBattleGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  private box = viewChild<ElementRef<HTMLInputElement>>('box');
  protected Math = Math;
  protected phase = signal<'countdown' | 'input' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected answers = signal<Answer[]>([]);
  protected lastSkipped = signal(false);
  protected now = signal(0);
  protected guess = '';
  private wordStart = 0;
  private resolve: ((a: Answer) => void) | null = null;
  private destroyed = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  protected total = computed(() => this.spec().words.length);
  protected current = computed(() => this.spec().words[Math.min(this.index(), this.total() - 1)]);
  protected letters = computed(() => this.current().scrambled.split(''));
  protected answeredCount = computed(() => this.answers().filter((a) => a.answer).length);
  protected elapsed = computed(() => (this.phase() === 'input' ? this.now() - this.wordStart : 0));
  protected timeLeft = computed(() => Math.max(0, Math.ceil((this.spec().limitMs - this.elapsed()) / 1000)));
  protected pct = computed(() => Math.max(0, 100 - (this.elapsed() / this.spec().limitMs) * 100));

  ngOnInit() { this.ticker = setInterval(() => this.now.set(performance.now()), 200); this.run(); }
  ngOnDestroy() { this.destroyed = true; clearInterval(this.ticker); }

  private async run() {
    const start = performance.now();
    const spec = this.spec();
    for (let c = Math.round(spec.countdownMs / 1000); c > 0; c--) { this.count.set(c); await sleep(1000); if (this.destroyed) return; }
    for (let i = 0; i < spec.words.length; i++) {
      this.index.set(i);
      this.guess = '';
      this.phase.set('input');
      this.wordStart = performance.now();
      this.now.set(this.wordStart);
      setTimeout(() => this.box()?.nativeElement.focus(), 30);
      const a = await new Promise<Answer>((resolve) => {
        const t = setTimeout(() => { this.resolve = null; resolve({ answer: this.guess.trim(), timeMs: spec.limitMs }); }, spec.limitMs);
        this.resolve = (x) => { clearTimeout(t); this.resolve = null; resolve(x); };
      });
      if (this.destroyed) return;
      this.answers.update((l) => [...l, a]);
      this.lastSkipped.set(!a.answer);
      this.phase.set('feedback');
      await sleep(450);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { words: this.answers() }, clientElapsedMs: Math.round(performance.now() - start) });
  }

  protected submit() {
    if (this.phase() !== 'input' || !this.guess.trim()) return;
    this.resolve?.({ answer: this.guess.trim().toLowerCase(), timeMs: Math.round(performance.now() - this.wordStart) });
  }

  protected skip() {
    this.resolve?.({ answer: '', timeMs: Math.round(performance.now() - this.wordStart) });
  }
}
