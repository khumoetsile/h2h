import { Injectable, signal } from '@angular/core';

/**
 * Carries "rematch this opponent" intent from a completed football match's
 * result screen to the fixture picker. Football can't literally replay the
 * same fixture (its real match has already kicked off/finished), so a
 * rematch means: same opponent, a new fixture the player picks next —
 * this just pre-fills who that challenge should go to.
 */
@Injectable({ providedIn: 'root' })
export class RematchService {
  private pending = signal<{ username: string; avatarColor: string } | null>(null);

  setPending(opponent: { username: string; avatarColor: string }) {
    this.pending.set(opponent);
  }

  /** Reads and clears the pending rematch target — a one-shot handoff. */
  consume() {
    const v = this.pending();
    this.pending.set(null);
    return v;
  }
}
