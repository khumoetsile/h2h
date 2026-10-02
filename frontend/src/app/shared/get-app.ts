import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { Api } from '../core/api.service';
import { MatIconModule } from '@angular/material/icon';
import { PwaService } from '../core/pwa.service';
import { Toast } from '../core/toast.service';

const DISMISS_KEY = 'h2h.getapp.dismissed';
const DISMISS_DAYS = 7;

/**
 * One small component for the two "keep me in the loop" asks: notifications and installing the app.
 *  - `card`: a dismissible nudge for the home page.
 *  - `waiting`: shown while someone waits for a friend, where notifications are the whole point.
 *  - `settings`: a plain on/off row.
 * It draws nothing when there is nothing useful to offer (already on, already installed, or the browser cannot).
 */
@Component({
  selector: 'app-get-app',
  imports: [MatIconModule],
  template: `
    @if (variant() === 'settings') {
      @if (push() === 'on' || push() === 'off') {
        <div class="settings">
        <div class="row">
          <mat-icon>{{ push() === 'on' ? 'notifications' : 'notifications_off' }}</mat-icon>
          <div class="grow"><strong>Notifications on this phone</strong>
            <p class="muted small">{{ push() === 'on' ? 'You will get a ping when an opponent joins or a match starts.' : 'Get a ping when an opponent joins or a match starts.' }}</p></div>
          <button class="btn btn-sm" [class.btn-primary]="push() === 'off'" [disabled]="busy()" (click)="toggle()">{{ push() === 'on' ? 'Turn off' : 'Turn on' }}</button>
        </div>
        @if (push() === 'on' && prefs(); as p) {
          <label class="pref">
            <input type="checkbox" [checked]="p.challenges" (change)="setPref('challenges', $any($event.target).checked)" />
            <span><strong>Challenges and matches</strong><small class="muted">When someone challenges you, joins your invite or a match is about to start.</small></span>
          </label>
          <label class="pref">
            <input type="checkbox" [checked]="p.waiting" (change)="setPref('waiting', $any($event.target).checked)" />
            <span><strong>When someone is looking for a game</strong><small class="muted">At most once every 3 hours, and never at night.</small></span>
          </label>
        }
        </div>
      } @else if (push() === 'blocked') {
        <p class="muted small">Notifications are blocked for this site. Allow them in your browser's site settings to turn them on.</p>
      }
    } @else if (show()) {
      <section class="nudge" [class.waiting]="variant() === 'waiting'">
        @if (push() === 'off') {
          <mat-icon>notifications</mat-icon>
          <div class="grow">
            <strong>{{ variant() === 'waiting' ? 'Get pinged when ' + (who() || 'your opponent') + ' joins' : 'Know when someone challenges you' }}</strong>
            <p class="muted small">Turn on notifications and you can close the app while you wait.</p>
          </div>
          <button class="btn btn-primary btn-sm" [disabled]="busy()" (click)="enable()">Turn on</button>
        } @else if (push() === 'needs-install') {
          <mat-icon>install_mobile</mat-icon>
          <div class="grow">
            <strong>Add Head2Head to your Home Screen</strong>
            <p class="muted small">Tap the Share button, then "Add to Home Screen". After that you can turn on notifications.</p>
          </div>
        } @else if (pwa.canInstall()) {
          <mat-icon>install_mobile</mat-icon>
          <div class="grow">
            <strong>Install the app</strong>
            <p class="muted small">Opens full screen from your home screen, no browser bar.</p>
          </div>
          <button class="btn btn-primary btn-sm" (click)="pwa.install()">Install</button>
        } @else if (pwa.needsIosSteps()) {
          <mat-icon>install_mobile</mat-icon>
          <div class="grow">
            <strong>Add to your Home Screen</strong>
            <p class="muted small">Tap the Share button, then "Add to Home Screen".</p>
          </div>
        }
        @if (variant() === 'card') { <button class="x" aria-label="Not now" (click)="dismiss()"><mat-icon>close</mat-icon></button> }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .settings { display: flex; flex-direction: column; gap: 8px; }
    .pref { display: flex; gap: 12px; align-items: flex-start; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
    .pref input { width: 22px; height: 22px; margin-top: 2px; accent-color: var(--accent); flex-shrink: 0; }
    .pref span { display: flex; flex-direction: column; gap: 2px; }
    .nudge, .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); text-align: left; }
    .nudge > mat-icon, .row > mat-icon { color: var(--accent); flex-shrink: 0; }
    .waiting { width: 100%; }
    .grow { flex: 1; min-width: 0; }
    .grow strong { font-size: 16px; }
    .grow p { margin: 2px 0 0; line-height: 1.35; }
    .x { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; color: var(--muted); border-radius: 4px; flex-shrink: 0; cursor: pointer; }
    .x:hover { background: var(--surface-2); color: var(--text); }
    .x mat-icon { font-size: 18px; width: 18px; height: 18px; }
  `],
})
export class GetApp implements OnInit {
  protected pwa = inject(PwaService);
  private toast = inject(Toast);

  readonly variant = input<'card' | 'waiting' | 'settings'>('card');
  /** The name to mention in the waiting-room line. */
  readonly who = input<string | null>(null);

  private api = inject(Api);
  protected push = this.pwa.pushState;
  protected prefs = signal<{ challenges: boolean; waiting: boolean } | null>(null);
  protected busy = signal(false);
  private dismissed = signal(this.wasDismissed());

  protected show = computed(() => {
    if (this.variant() === 'card' && this.dismissed()) return false;
    const p = this.push();
    if (p === 'off' || p === 'needs-install') return true;
    // Installing is offered on the home page only; while waiting only notifications matter.
    return this.variant() === 'card' && (this.pwa.canInstall() || this.pwa.needsIosSteps());
  });

  ngOnInit() {
    void this.pwa.refreshPush();
    if (this.variant() === 'settings') {
      this.api.get<{ settings: { challenges: boolean; waiting: boolean } }>('/me/notification-settings').then((r) => this.prefs.set(r.settings)).catch(() => undefined);
    }
  }

  protected async setPref(key: 'challenges' | 'waiting', value: boolean) {
    const before = this.prefs();
    if (before) this.prefs.set({ ...before, [key]: value });
    try {
      this.prefs.set((await this.api.put<{ settings: { challenges: boolean; waiting: boolean } }>('/me/notification-settings', { [key]: value })).settings);
    } catch (err) {
      this.prefs.set(before);
      this.toast.error(err);
    }
  }

  private wasDismissed() {
    try {
      const t = Number(localStorage.getItem(DISMISS_KEY));
      return !!t && Date.now() - t < DISMISS_DAYS * 86400000;
    } catch { return false; }
  }

  protected dismiss() {
    this.dismissed.set(true);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
  }

  protected async enable() {
    this.busy.set(true);
    try {
      if (await this.pwa.enablePush()) this.toast.success('Notifications are on.');
      else if (this.push() === 'blocked') this.toast.info('Notifications are blocked. Allow them in your browser settings.');
    } catch (err) { this.toast.error(err); } finally { this.busy.set(false); }
  }

  protected async toggle() {
    this.busy.set(true);
    try { if (this.push() === 'on') await this.pwa.disablePush(); else await this.enable(); } catch (err) { this.toast.error(err); } finally { this.busy.set(false); }
  }
}
