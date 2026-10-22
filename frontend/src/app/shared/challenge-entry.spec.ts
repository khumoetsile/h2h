import { describe, expect, it } from 'vitest';
import { normalizeChallengeCode } from './challenge-entry';

describe('challenge code entry', () => {
  it('accepts new codes and existing invitations without changing their identity', () => {
    expect(normalizeChallengeCode(' h2h-abcdefgh ')).toBe('H2H-ABCDEFGH');
    expect(normalizeChallengeCode('m-23456789')).toBe('M-23456789');
  });
  it('rejects incomplete codes, ambiguous characters, paths and URLs', () => {
    for (const code of ['H2H-ABC', 'H2H-00000000', '../match', 'https://example.com/join/M-ABCDEFGH', 'M-ABCDEFGH/extra']) expect(normalizeChallengeCode(code)).toBeNull();
  });
});
