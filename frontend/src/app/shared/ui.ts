import { Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { initials } from '../core/format';
import { MatchStatus, Outcome } from '../core/models';

@Component({
  selector: 'app-demo-badge',
  template: `<span class="chip chip-demo" [class.lg]="size() === 'lg'"><span class="dot"></span>{{ label() }}</span>`,
  styles: [`
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
    .lg { height: 26px; font-size: 12px; padding: 0 10px; }
  `],
})
export class DemoBadge {
  readonly label = input('Demo');
  readonly size = input<'sm' | 'lg'>('sm');
}

@Component({
  selector: 'app-avatar',
  template: `<span class="av" [style.background]="color()" [style.width.px]="size()" [style.height.px]="size()" [style.font-size.px]="size() * 0.38">{{ text() }}</span>`,
  styles: [`
    .av { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #0a0d13; font-weight: 700;
      font-family: var(--font-display); flex-shrink: 0; letter-spacing: .02em; }
  `],
})
export class Avatar {
  readonly name = input.required<string>();
  readonly color = input<string>('#3B82F6');
  readonly size = input(36);
  readonly text = computed(() => initials(this.name()));
}

@Component({
  selector: 'app-empty',
  imports: [MatIconModule],
  template: `
    <div class="empty">
      <mat-icon>{{ icon() }}</mat-icon>
      <h3>{{ title() }}</h3>
      @if (text()) { <p>{{ text() }}</p> }
      <ng-content />
    </div>`,
  styles: [`
    .empty { text-align: center; padding: 40px 16px; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 8px; }
    mat-icon { font-size: 36px; width: 36px; height: 36px; color: var(--border-strong); }
    h3 { color: var(--text-2); font-size: 15px; }
    p { font-size: 14px; max-width: 360px; margin-bottom: 8px; }
  `],
})
export class EmptyState {
  readonly icon = input('inbox');
  readonly title = input.required<string>();
  readonly text = input<string>('');
}

@Component({
  selector: 'app-skeleton-list',
  template: `
    @for (r of rowsArr(); track $index) {
      <div class="sk-row">
        <div class="skeleton circle"></div>
        <div class="lines"><div class="skeleton l1"></div><div class="skeleton l2"></div></div>
        <div class="skeleton r"></div>
      </div>
    }`,
  styles: [`
    .sk-row { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .sk-row:last-child { border-bottom: 0; }
    .circle { width: 34px; height: 34px; border-radius: 50%; }
    .lines { flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .l1 { height: 12px; width: 45%; } .l2 { height: 10px; width: 28%; }
    .r { width: 64px; height: 14px; }
  `],
})
export class SkeletonList {
  readonly rows = input(4);
  readonly rowsArr = computed(() => Array.from({ length: this.rows() }));
}

@Component({
  selector: 'app-load-error',
  imports: [MatIconModule],
  template: `
    <div class="err">
      <mat-icon>cloud_off</mat-icon>
      <div class="msg">{{ message() }}</div>
      <button class="btn btn-sm" (click)="retry.emit()"><mat-icon>refresh</mat-icon>Try again</button>
    </div>`,
  styles: [`
    .err { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; text-align: center; color: var(--text-2); }
    mat-icon { color: var(--loss); }
  `],
})
export class LoadError {
  readonly message = input('Could not load data.');
  readonly retry = output<void>();
}

@Component({
  selector: 'app-spinner',
  imports: [MatProgressSpinnerModule],
  template: `<div class="sp" [class.inline]="inline()"><mat-spinner [diameter]="size()" /></div>`,
  styles: [`.sp { display: flex; justify-content: center; padding: 40px; } .inline { padding: 0; display: inline-flex; }`],
})
export class Spinner {
  readonly size = input(32);
  readonly inline = input(false);
}

const STATUS_LABEL: Record<MatchStatus, string> = {
  WAITING: 'Waiting', MATCHED: 'Matched', READY: 'Ready', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

@Component({
  selector: 'app-match-status',
  template: `<span class="chip" [class]="cls()">{{ label() }}</span>`,
})
export class MatchStatusChip {
  readonly status = input.required<MatchStatus>();
  readonly label = computed(() => STATUS_LABEL[this.status()]);
  readonly cls = computed(() => {
    switch (this.status()) {
      case 'WAITING': return 'chip chip-demo';
      case 'MATCHED': case 'READY': return 'chip chip-info';
      case 'IN_PROGRESS': return 'chip chip-accent';
      case 'COMPLETED': return 'chip';
      default: return 'chip chip-loss';
    }
  });
}

@Component({
  selector: 'app-outcome',
  template: `<span class="chip" [class]="cls()">{{ label() }}</span>`,
})
export class OutcomeChip {
  readonly outcome = input<Outcome>(null);
  readonly status = input<MatchStatus | null>(null);
  readonly label = computed(() => {
    const o = this.outcome();
    if (o === 'WIN') return 'Won';
    if (o === 'LOSS') return 'Lost';
    if (o === 'DRAW') return 'Draw';
    if (o === 'REFUNDED' || this.status() === 'CANCELLED') return 'Cancelled';
    return STATUS_LABEL[this.status() ?? 'WAITING'];
  });
  readonly cls = computed(() => {
    const o = this.outcome();
    if (o === 'WIN') return 'chip chip-win';
    if (o === 'LOSS') return 'chip chip-loss';
    if (o === 'DRAW') return 'chip chip-info';
    if (o === 'REFUNDED' || this.status() === 'CANCELLED') return 'chip';
    return 'chip chip-accent';
  });
}

/** Game glyph used on cards; a simple mark per game rather than stock art. */
@Component({
  selector: 'app-game-icon',
  imports: [MatIconModule],
  template: `<span class="gi" [style.--c]="color()" [style.width.px]="size()" [style.height.px]="size()"><mat-icon [style.font-size.px]="size() * 0.5" [style.width.px]="size() * 0.5" [style.height.px]="size() * 0.5">{{ icon() }}</mat-icon></span>`,
  styles: [`
    .gi { display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; flex-shrink: 0;
      background: color-mix(in srgb, var(--c) 14%, transparent); color: var(--c); border: 1px solid color-mix(in srgb, var(--c) 30%, transparent); }
  `],
})
export class GameIcon {
  readonly slug = input.required<string>();
  readonly color = input('#22D3EE');
  readonly size = input(44);
  readonly icon = computed(() => ({
    'reaction-rush': 'bolt',
    'penalty-shootout': 'sports_soccer',
    'word-battle': 'spellcheck',
    'memory-battle': 'grid_view',
    'aim-challenge': 'my_location',
  } as Record<string, string>)[this.slug()] ?? 'sports_esports');
}
