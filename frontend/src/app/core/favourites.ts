import { computed, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';

export interface Favourite { kind: 'team' | 'competition'; id: number; name: string; }
export function readFavourites(raw: string | null): Favourite[] {
  try {
    const data: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((v): v is Favourite => !!v && (v.kind === 'team' || v.kind === 'competition') && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.name === 'string' && v.name.length <= 150).slice(0, 30);
  } catch { return []; }
}

/** Browser preferences are scoped to the signed-in player; no contact details are stored. */
@Injectable({ providedIn: 'root' })
export class Favourites {
  private auth = inject(AuthService);
  private revision = signal(0);
  private key = computed(() => `h2h.favourites.${this.auth.user()?.id ?? 'guest'}`);
  readonly warning = signal('');
  readonly items = computed(() => {
    this.revision();
    try { return readFavourites(localStorage.getItem(this.key())); } catch { return []; }
  });
  has(kind: Favourite['kind'], id: number) { return this.items().some(v => v.kind === kind && v.id === id); }
  toggle(value: Favourite) {
    const items = this.items();
    const next = this.has(value.kind, value.id) ? items.filter(v => v.kind !== value.kind || v.id !== value.id) : [...items, value];
    if (next.length > 30) { this.warning.set('You can follow up to 30 teams and leagues.'); return; }
    try { localStorage.setItem(this.key(), JSON.stringify(next)); this.warning.set(''); this.revision.update(v => v + 1); }
    catch { this.warning.set('Your browser could not save favourites. Allow site storage and try again.'); }
  }
}
