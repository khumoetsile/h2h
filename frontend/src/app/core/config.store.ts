import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api.service';
import { formatMoney } from './format';
import { PublicConfig } from './models';

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  private api = inject(Api);
  readonly config = signal<PublicConfig | null>(null);
  /** The abandonment fee exactly as the server charges it, pre-formatted for disclosure copy ("P0.50"). */
  readonly abandonmentFee = computed(() => formatMoney(this.config()?.abandonmentFee ?? 0.5));
  readonly timers = computed(() => this.config()?.timers ?? null);

  async load() {
    try {
      this.config.set(await this.api.get<PublicConfig>('/config'));
    } catch {
      /* the UI falls back to defaults; pages that need config show their own errors */
    }
    return this.config();
  }

  async ensure() {
    return this.config() ?? this.load();
  }
}
