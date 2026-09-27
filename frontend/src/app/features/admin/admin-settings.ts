import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api.service';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { DemoBadge, LoadError, Spinner } from '../../shared/ui';

interface SettingRow { key: string; value: unknown; description: string; updatedAt: string | null; }
interface AuditEntry { id: number; admin: string; action: string; targetType: string | null; targetId: string | null; details: unknown; createdAt: string; }

const NUMERIC = ['signup_bonus', 'max_deposit', 'min_withdrawal'];
const LABELS: Record<string, string> = {
  signup_bonus: 'Signup bonus (P, demo)', max_deposit: 'Max demo deposit (P)', min_withdrawal: 'Min demo withdrawal (P)',
};
// Challenge timers are not admin settings: they're env config (backend
// config.timers) — see README "Timers".

@Component({
  selector: 'app-admin-settings',
  imports: [FormsModule, DatePipe, MatIconModule, MoneyPipe, DemoBadge, LoadError, Spinner],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Platform settings</h1><p class="sub">Changes apply to new matches immediately. In-flight matches keep the fee they started with.</p></div><app-demo-badge label="Demo economy" size="lg" /></div>
      @if (error()) { <app-load-error [message]="error()" (retry)="load()" /> }
      @else if (!rows()) { <app-spinner /> }
      @else {
        <div class="grid">
          <section class="card">
            <h3>Platform fee</h3>
            <p class="muted small">{{ desc('platform_fee_percent') }}</p>
            <div class="fee-row">
              <input type="range" min="0" max="50" step="0.5" [(ngModel)]="fee" (ngModelChange)="feeSig.set(+$event || 0)" />
              <div class="num-in"><input type="number" min="0" max="50" step="0.5" [(ngModel)]="fee" (ngModelChange)="feeSig.set(+$event || 0)" /><span>%</span></div>
            </div>
            <div class="preview">
              <div class="row-between muted small"><span>Example: two players stake P20</span></div>
              <div class="row-between"><span class="muted">Total pool</span><span class="money">{{ 40 | money }}</span></div>
              <div class="row-between"><span class="muted">Platform fee</span><span class="money">{{ exampleFee() | money }}</span></div>
              <div class="row-between"><strong>Winner receives</strong><strong class="money accent">{{ 40 - exampleFee() | money }}</strong></div>
            </div>
            <button class="btn btn-primary" [disabled]="saving() === 'fee'" (click)="save('fee', { platform_fee_percent: +fee })">Save fee</button>
          </section>

          <section class="card">
            <h3>Stake amounts</h3>
            <p class="muted small">{{ desc('stake_amounts') }}</p>
            <div class="chips">
              @for (s of stakes; track s) { <span class="stake-chip money">{{ s | money }} <button (click)="removeStake(s)" aria-label="Remove">×</button></span> }
            </div>
            <div class="add"><input type="number" min="1" [(ngModel)]="newStake" placeholder="Add amount" (keydown.enter)="addStake()" /><button class="btn btn-sm" (click)="addStake()">Add</button></div>
            <button class="btn btn-primary" [disabled]="saving() === 'stakes' || stakes.length === 0" (click)="save('stakes', { stake_amounts: stakes })">Save stakes</button>
          </section>

          <section class="card">
            <h3>Deposit presets</h3>
            <p class="muted small">{{ desc('deposit_presets') }}</p>
            <input class="text-in" [(ngModel)]="presetsText" placeholder="10, 20, 50" />
            <button class="btn btn-primary" [disabled]="saving() === 'presets'" (click)="savePresets()">Save presets</button>
          </section>

          <section class="card">
            <h3>Limits & timeouts</h3>
            <div class="limits">
              @for (k of numeric; track k) {
                <label><span class="muted small">{{ label(k) }}</span><input type="number" [(ngModel)]="nums[k]" min="0" /></label>
              }
            </div>
            <button class="btn btn-primary" [disabled]="saving() === 'limits'" (click)="saveLimits()">Save limits</button>
          </section>
        </div>

        <div class="card card-flush" style="margin-top:16px">
          <div class="card-head"><h3>Admin audit log</h3></div>
          @if ((audit() ?? []).length === 0) { <p class="muted small" style="padding:16px">No admin actions yet.</p> }
          @else {
            <div class="table-wrap"><table class="table">
              <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
              <tbody>
                @for (a of audit(); track a.id) {
                  <tr><td class="muted">{{ a.createdAt | date: 'd MMM, HH:mm' }}</td><td>&#64;{{ a.admin }}</td><td><span class="chip">{{ a.action }}</span></td>
                    <td class="muted">{{ a.targetType }} {{ a.targetId }}</td><td class="muted small det">{{ json(a.details) }}</td></tr>
                }
              </tbody>
            </table></div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .card { display: flex; flex-direction: column; gap: 12px; }
    .fee-row { display: flex; align-items: center; gap: 14px; input[type=range] { flex: 1; accent-color: var(--accent); } }
    .num-in { display: flex; align-items: center; gap: 4px; input { width: 80px; } }
    input[type=number], .text-in { height: 38px; background: var(--bg-elev); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text); padding: 0 10px; font: inherit; }
    .preview { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .stake-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border-strong); font-weight: 600;
      button { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; &:hover { color: var(--loss); } } }
    .add { display: flex; gap: 8px; input { flex: 1; } }
    .limits { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; label { display: flex; flex-direction: column; gap: 4px; } }
    .det { white-space: normal; max-width: 360px; }
  `],
})
export class AdminSettingsPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  private configStore = inject(ConfigStore);
  protected rows = signal<SettingRow[] | null>(null);
  protected audit = signal<AuditEntry[] | null>(null);
  protected error = signal('');
  protected saving = signal<string | null>(null);
  protected numeric = NUMERIC;
  protected fee = 10;
  protected stakes: number[] = [];
  protected newStake: number | null = null;
  protected presetsText = '';
  protected nums: Record<string, number> = {};
  protected feeSig = signal(10);
  protected exampleFee = computed(() => Math.round(40 * this.feeSig()) / 100);

  ngOnInit() { this.load(); }
  label(k: string) { return LABELS[k] ?? k; }
  desc(k: string) { return this.rows()?.find((r) => r.key === k)?.description ?? ''; }
  json(v: unknown) { return v == null ? '' : JSON.stringify(v); }

  async load() {
    this.error.set('');
    try {
      const [s, a] = await Promise.all([
        this.api.get<{ settings: SettingRow[] }>('/admin/settings'),
        this.api.get<{ entries: AuditEntry[] }>('/admin/audit'),
      ]);
      this.apply(s.settings);
      this.audit.set(a.entries);
    } catch { this.error.set('Could not load settings.'); }
  }

  private apply(rows: SettingRow[]) {
    this.rows.set(rows);
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    this.fee = Number(v['platform_fee_percent']);
    this.feeSig.set(this.fee);
    this.stakes = [...(v['stake_amounts'] as number[])];
    this.presetsText = (v['deposit_presets'] as number[]).join(', ');
    for (const k of NUMERIC) this.nums[k] = Number(v[k]);
  }

  addStake() {
    const n = Number(this.newStake);
    if (!n || n <= 0) { this.toast.error('Enter a positive amount.'); return; }
    if (!this.stakes.includes(n)) this.stakes = [...this.stakes, n].sort((a, b) => a - b);
    this.newStake = null;
  }
  removeStake(s: number) { this.stakes = this.stakes.filter((x) => x !== s); }

  savePresets() {
    const list = this.presetsText.split(/[,\s]+/).filter(Boolean).map(Number);
    if (list.some((n) => !Number.isFinite(n) || n <= 0)) { this.toast.error('Presets must be positive numbers separated by commas.'); return; }
    return this.save('presets', { deposit_presets: list });
  }
  saveLimits() {
    const patch: Record<string, number> = {};
    for (const k of NUMERIC) patch[k] = Number(this.nums[k]);
    return this.save('limits', patch);
  }

  async save(section: string, patch: Record<string, unknown>) {
    this.saving.set(section);
    try {
      const r = await this.api.put<{ settings: SettingRow[] }>('/admin/settings', patch);
      this.apply(r.settings);
      this.configStore.load();
      this.audit.set((await this.api.get<{ entries: AuditEntry[] }>('/admin/audit')).entries);
      this.toast.success('Settings saved.');
    } catch (err) { this.toast.error(apiError(err).message); } finally { this.saving.set(null); }
  }
}
