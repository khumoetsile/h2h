import { Component, computed, ElementRef, input, OnDestroy, OnInit, output, signal, viewChild } from '@angular/core';
import { GameFinish, nextPaint, sleep } from './game-types';
import { buzz, burst, flash, floatText, GameAudio, ripple, shake } from './game-fx';

interface Round { delayMs: number; x: number; y: number; size: number; }
interface Spec { rounds: Round[]; windowMs: number; countdownMs: number; interRoundMs: number; }
interface RoundResult { hit: boolean; reactionMs: number | null; falseStart?: boolean; }

const CYAN = '#22d3ee';

/** Mirrors the server formula for instant feedback. The server score is authoritative. */
const pointsFor = (rt: number) => Math.min(1000, Math.max(100, Math.round(1100 - rt * 0.8)));

const rank = (ms: number) => (ms < 230 ? { label: 'Lightning', cls: 'gx-good', q: 1 } : ms < 300 ? { label: 'Fast', cls: 'gx-good', q: 0.75 } : ms < 400 ? { label: 'Good', cls: 'gx-warn', q: 0.5 } : { label: 'Slow', cls: 'gx-bad', q: 0.2 });

/**
 * Reaction Rush: ten rounds, one circle each. Wait for it, tap it the instant it appears. Faster is worth more,
 * tapping early costs the round. The same ten circles, in the same places, for both players.
 */
@Component({
  selector: 'app-reaction-rush',
  styleUrl: './game-hud.scss',
  template: `
    <div class="gx-top">
      <div class="gx-score"><span>Score</span><strong [class.bump]="bump()">{{ score() }}</strong></div>
      <div class="gx-mid">@if (streak() >= 2) { <span class="gx-streak">{{ streak() }} in a row</span> }</div>
      <div class="gx-round"><span>Round</span><strong>{{ Math.min(index() + 1, total()) }}/{{ total() }}</strong></div>
    </div>

    <div class="gx-arena" #arena (pointerdown)="arenaDown()" style="--gx-glow: rgba(34, 211, 238, .14)">
      @switch (phase()) {
        @case ('countdown') {
          <div class="gx-center">
            <div class="gx-count" [attr.data-n]="count()">{{ count() }}</div>
            <p class="gx-hint">A circle will appear. Tap it the moment you see it. Don't tap early.</p>
          </div>
        }
        @case ('wait') {
          <div class="gx-center">
            <div class="wait-ring"></div>
            <p class="gx-hint">{{ index() === 0 ? 'Wait for the circle…' : 'Wait…' }}</p>
          </div>
        }
        @case ('target') {
          <button class="orb" [style.left]="edge(current().x, current().size + 14)" [style.top]="edge(current().y, current().size + 14)" [style.width.px]="current().size + 14" [style.height.px]="current().size + 14"
                  (pointerdown)="hit($event)" aria-label="Tap now"></button>
        }
        @case ('feedback') {
          <div class="gx-center">
            @if (feedback().good) {
              <div class="gx-big" [class]="feedback().cls">{{ feedback().big }}</div>
              <div class="gx-label" [class]="feedback().cls">{{ feedback().title }}</div>
              <div class="gx-hint">{{ feedback().sub }}</div>
            } @else {
              <div class="gx-label gx-bad">{{ feedback().title }}</div>
              <div class="gx-hint">{{ feedback().sub }}</div>
            }
          </div>
        }
        @case ('done') {
          <div class="gx-center"><div class="gx-label">Finished</div><div class="gx-hint">Checking your result…</div></div>
        }
      }
    </div>

    <div class="gx-pips">
      @for (r of results(); track $index) { <i [class.hit]="r.hit" [class.miss]="!r.hit"></i> }
      @for (i of remaining(); track $index) { <i [class.cur]="$first && phase() !== 'countdown'"></i> }
    </div>
  `,
  styles: [`
    .wait-ring { width: 120px; height: 120px; border-radius: 50%; border: 3px solid rgba(34, 211, 238, .35); animation: wait 1.4s ease-in-out infinite; }
    @keyframes wait { 0%, 100% { transform: scale(.7); opacity: .4; } 50% { transform: scale(1); opacity: 1; } }
    .orb {
      position: absolute; transform: translate(-50%, -50%); border-radius: 50%; border: 0; padding: 0; cursor: pointer; z-index: 4; touch-action: manipulation;
      background: radial-gradient(circle at 35% 30%, #cffafe 0 12%, #22d3ee 13% 60%, #0891b2 100%);
      box-shadow: 0 0 0 5px rgba(34, 211, 238, .25), 0 0 36px rgba(34, 211, 238, .55);
      animation: appear .1s ease-out both;
    }
    .orb::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; border: 3px solid #22d3ee; animation: ping .5s ease-out both; }
    @keyframes appear { from { transform: translate(-50%, -50%) scale(.5); } to { transform: translate(-50%, -50%) scale(1); } }
    @keyframes ping { from { transform: scale(.8); opacity: .9; } to { transform: scale(1.8); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .wait-ring, .orb, .orb::after { animation: none; } }
  `],
})
export class ReactionRushGame implements OnInit, OnDestroy {
  readonly spec = input.required<Spec>();
  readonly finished = output<GameFinish>();
  protected Math = Math;
  private arena = viewChild.required<ElementRef<HTMLElement>>('arena');
  private audio = new GameAudio();

  protected phase = signal<'countdown' | 'wait' | 'target' | 'feedback' | 'done'>('countdown');
  protected count = signal(3);
  protected index = signal(0);
  protected results = signal<RoundResult[]>([]);
  protected streak = signal(0);
  protected bump = signal(false);
  protected feedback = signal({ big: '', title: '', sub: '', good: true, cls: 'gx-good' });
  protected total = computed(() => this.spec().rounds.length);
  protected current = computed(() => this.spec().rounds[Math.min(this.index(), this.total() - 1)]);
  protected remaining = computed(() => Array.from({ length: this.total() - this.results().length }));
  protected score = computed(() => this.results().reduce((a, r) => a + (r.hit && r.reactionMs ? pointsFor(r.reactionMs) : 0), 0));

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
      this.audio.tick();
      await sleep(1000);
      if (this.destroyed) return;
    }
    for (let i = 0; i < spec.rounds.length; i++) {
      this.index.set(i);
      const result = await this.playRound(spec.rounds[i], spec.windowMs);
      if (this.destroyed) return;
      this.results.update((r) => [...r, result]);
      this.showFeedback(result);
      await sleep(spec.interRoundMs);
    }
    this.phase.set('done');
    this.finished.emit({ actions: { rounds: this.results() }, clientElapsedMs: Math.round(performance.now() - this.startedAt) });
  }

  /** Keeps the circle fully inside the arena, whatever the screen size. */
  protected edge(pct: number, size: number) {
    const r = size / 2 + 6;
    return `clamp(${r}px, ${pct}%, calc(100% - ${r}px))`;
  }

  private showFeedback(r: RoundResult) {
    const host = this.arena().nativeElement;
    const box = host.getBoundingClientRect();
    const round = this.current();
    const rad = (round.size + 14) / 2 + 6;
    const x = Math.min(box.width - rad, Math.max(rad, (round.x / 100) * box.width));
    const y = Math.min(box.height - rad, Math.max(rad, (round.y / 100) * box.height));
    if (r.hit && r.reactionMs) {
      const pts = pointsFor(r.reactionMs);
      const k = rank(r.reactionMs);
      this.streak.update((n) => n + 1);
      this.bumpScore();
      burst(host, x, y, CYAN, 12);
      ripple(host, x, y, CYAN);
      floatText(host, x, y - 20, `+${pts}`, '#5ccb8a', 28);
      this.audio.hit(k.q);
      if (this.streak() >= 3) this.audio.streak(this.streak());
      buzz(14);
      this.feedback.set({ big: `${r.reactionMs} ms`, title: k.label, sub: `+${pts} points`, good: true, cls: k.cls });
    } else if (r.falseStart) {
      this.streak.set(0);
      shake(host);
      flash(host, '#ef4444');
      this.audio.wrong();
      buzz([40, 30, 40]);
      this.feedback.set({ big: '', title: 'Too early', sub: 'Wait for the circle. No points for this one.', good: false, cls: 'gx-bad' });
    } else {
      this.streak.set(0);
      this.audio.miss();
      this.feedback.set({ big: '', title: 'Too slow', sub: 'The circle was gone. No points.', good: false, cls: 'gx-bad' });
    }
    this.phase.set('feedback');
  }

  private bumpScore() {
    this.bump.set(true);
    setTimeout(() => this.bump.set(false), 320);
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
        this.audio.pop();
        timeout = setTimeout(() => settle({ hit: false, reactionMs: null }), windowMs);
      }, round.delayMs);
    });
  }

  protected hit(ev: PointerEvent) {
    ev.stopPropagation();
    this.audio.unlock();
    if (this.phase() !== 'target' || !this.resolveRound || !this.shownAt) return;
    const rt = Math.round(performance.now() - this.shownAt);
    this.shownAt = 0;
    this.resolveRound({ hit: true, reactionMs: rt });
  }

  protected arenaDown() {
    this.audio.unlock();
    // Tapping before the circle appears is a false start.
    if (this.phase() === 'wait' && this.resolveRound) this.resolveRound({ hit: false, reactionMs: null, falseStart: true });
  }
}
