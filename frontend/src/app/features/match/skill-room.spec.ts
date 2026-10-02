import { MatchView } from '../../core/models';
import { roomPhase } from './skill-room';

/** A minimal match, from the viewer's side. */
function match(status: string, me: Partial<{ owesAction: boolean; submitted: boolean }> = {}): MatchView {
  return {
    status,
    viewerId: 1,
    players: [
      { userId: 1, owesAction: false, submitted: false, ...me },
      { userId: 2, owesAction: false, submitted: false },
    ],
  } as unknown as MatchView;
}

describe('roomPhase', () => {
  it('searching while nobody has joined', () => {
    expect(roomPhase(match('WAITING'))).toBe('searching');
  });

  it('"found" only while the player still has to get ready', () => {
    expect(roomPhase(match('MATCHED', { owesAction: true }))).toBe('found');
    expect(roomPhase(match('MATCHED', { owesAction: false }))).toBe('waiting-opponent');
  });

  it('starting once both are ready', () => {
    expect(roomPhase(match('READY'))).toBe('starting');
  });

  it('playing until the player has finished, then waiting for the opponent', () => {
    expect(roomPhase(match('IN_PROGRESS'))).toBe('playing');
    expect(roomPhase(match('IN_PROGRESS', { submitted: true }))).toBe('waiting-finish');
  });
});
