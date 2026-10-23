import { computed, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
export type Interest = 'football' | 'games' | 'chess';
const allowed: Interest[] = ['football','games','chess'];
@Injectable({providedIn:'root'})
export class ExperiencePreferences {
  private auth = inject(AuthService);
  private revision = signal(0);
  private key = computed(() => `h2h.setup.${this.auth.user()?.id ?? 'guest'}`);
  readonly settings = computed<{interests:Interest[]} | null>(() => {
    this.revision();
    try {
      const v = JSON.parse(localStorage.getItem(this.key()) ?? 'null');
      return v && Array.isArray(v.interests) ? {interests: v.interests.filter((x:unknown) => allowed.includes(x as Interest))} : null;
    } catch { return null; }
  });
  save(interests: Interest[]) {
    try { localStorage.setItem(this.key(), JSON.stringify({interests})); this.revision.update(n=>n+1); return true; }
    catch { return false; }
  }
}
