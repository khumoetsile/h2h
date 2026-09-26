import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api.service';
import { PublicConfig } from './models';

@Injectable({ providedIn: 'root' })
export class ConfigStore {
  private api = inject(Api);
  readonly config = signal<PublicConfig | null>(null);

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
