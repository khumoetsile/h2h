import { Injectable, signal } from '@angular/core';

export interface RematchIntent {
  username: string;
  avatarColor: string;
  /** Pre-select the same question on the next fixture, if it's offered there. */
  challengeTypeSlug?: string | null;
  /** Pre-select the same stake. */
  stake?: number | null;
}

/**
 * Carries "challenge this player" intent (a rematch from a result screen, or
 * "Challenge Khumo" from a profile) to the fixture picker. A football
 * rematch can't replay the same fixture — its real match already happened —
 * so it always becomes a brand-new challenge (new match, new picks, new
 * stake, new transactions and settlement) on a fixture the player picks next.
 */
@Injectable({ providedIn: 'root' })
export class RematchService {
  private pending = signal<RematchIntent | null>(null);
  readonly current = this.pending.asReadonly();

  setPending(intent: RematchIntent) {
    this.pending.set(intent);
  }

  clear() {
    this.pending.set(null);
  }

  /** Reads and clears the pending target — a one-shot handoff. */
  consume() {
    const v = this.pending();
    this.pending.set(null);
    return v;
  }
}
