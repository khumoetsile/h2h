import { ExperienceMeasurement } from '../core/experience-measurement';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ExperiencePreferences, Interest } from '../core/experience-preferences';
/** Optional, reversible setup. Active matches are never hidden by an interest preference. */
@Component({
  selector: 'app-experience-setup', imports: [RouterLink],
  template: `@if (visible()) { <section class="card setup" aria-label="Personalise Head2Head"><div><h2>Make this your Head2Head</h2><p class="muted small">Choose what interests you. You can change this later on your profile.</p></div><div class="options">@for (v of choices; track v.key) { <button class="btn btn-sm" [attr.aria-pressed]="selected().includes(v.key)" (click)="toggle(v.key)">{{ v.label }}</button> }</div><div class="options"><button class="btn btn-primary btn-sm" (click)="finish()">Save preferences</button>@if(!settingsMode()){<button class="btn btn-ghost btn-sm" (click)="skip()">Skip for now</button>}<a routerLink="/football">Follow teams and leagues →</a></div>@if(error()) { <p role="status">{{ error() }}</p> }</section> }`,
  styles: [`.setup {margin:20px 0;display:flex;flex-direction:column;gap:12px}.options {display:flex;flex-wrap:wrap;gap:10px;align-items:center} [aria-pressed=true] {border-color:var(--accent);background:var(--accent-soft)}`],
})
export class ExperienceSetup {
  private preferences = inject(ExperiencePreferences);
  private measurement = inject(ExperienceMeasurement);
  readonly settingsMode = input(false);
  protected selected = signal<Interest[]>([]);
  protected error = signal('');
  private dismissed = signal(false);
  protected visible = computed(() => this.settingsMode() || (!this.dismissed() && !this.preferences.settings()));
  constructor() { effect(() => this.selected.set(this.preferences.settings()?.interests ?? [])); }
  protected choices: {key:Interest;label:string}[] = [{key:'football',label:'Football & predictions'},{key:'games',label:'Live skill games'},{key:'chess',label:'Chess at your pace'}];
  protected toggle(v: Interest) { this.selected.update(rows => rows.includes(v) ? rows.filter(x => x !== v) : [...rows,v]); }
  protected skip() { this.preferences.save([]); this.dismissed.set(true); }
  protected finish() {
    const saved = this.preferences.save(this.selected());
    if (saved) this.measurement.record('onboarding_saved','home');
    this.error.set(saved ? (this.settingsMode() ? 'Preferences saved for this browser.' : '') : 'Could not save your preferences in this browser.');
  }
}
