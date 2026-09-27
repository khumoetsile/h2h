import { Component, computed, effect, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { formatRemaining, ServerClock } from '../core/server-clock';

/**
 * Renders the time left until a SERVER deadline. Display only — when it
 * reaches zero it emits `expired` so the page can refetch the server's
 * verdict; it never decides an outcome itself.
 */
@Component({
  selector: 'app-countdown',
  imports: [MatIconModule],
  template: `
    <span class="cd" [class.urgent]="urgent()" [class.big]="size() === 'big'" [class.done]="remaining() === 0" role="timer" [attr.aria-label]="label()">
      @if (icon()) { <mat-icon>timer</mat-icon> }
      <span class="num">{{ text() }}</span>
    </span>
  `,
  styles: [`
    :host { display: inline-flex; }
    .cd { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-display); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
    .cd mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--muted); }
    .cd.big { font-size: 40px; line-height: 1; letter-spacing: .02em; }
    .cd.big mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .urgent, .urgent mat-icon { color: var(--loss); }
    .done { opacity: .7; }
  `],
})
export class Countdown {
  private clock = inject(ServerClock);
  readonly deadline = input<string | Date | null | undefined>(null);
  readonly size = input<'normal' | 'big'>('normal');
  readonly icon = input(true);
  /** Show the red "urgent" style under this many seconds. */
  readonly urgentUnder = input(30);
  readonly expired = output<void>();

  protected remaining = computed(() => this.clock.remainingMs(this.deadline()));
  protected text = computed(() => formatRemaining(this.remaining()));
  protected urgent = computed(() => this.remaining() > 0 && this.remaining() < this.urgentUnder() * 1000);
  protected label = computed(() => `${this.text()} remaining`);

  private fired = false;
  constructor() {
    effect(() => {
      const r = this.remaining();
      const d = this.deadline();
      if (d && r === 0 && !this.fired) { this.fired = true; this.expired.emit(); }
      if (r > 0) this.fired = false;
    });
  }
}
