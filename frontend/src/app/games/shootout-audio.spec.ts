import { ShootoutAudio } from './shootout-audio';

/** Just enough of the Web Audio API to run every sound without a real audio device. */
let nodesCreated = 0;
class FakeParam {
  value = 0;
  cancelScheduledValues() { return this; }
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = '';
  buffer: unknown = null;
  constructor() { nodesCreated += 1; }
  connect() { return this; }
  start() { /* noop */ }
  stop() { /* noop */ }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  state = 'running';
  destination = {};
  createGain() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createBuffer(_c: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  resume() { return Promise.resolve(); }
}

describe('ShootoutAudio', () => {
  beforeEach(() => {
    nodesCreated = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
    localStorage.removeItem('h2h.sound');
  });

  it('plays nothing until it has been unlocked by a tap', () => {
    const a = new ShootoutAudio();
    a.whistle(); a.kick(); a.cheer();
    expect(nodesCreated).toBe(0);
  });

  it('every sound runs once unlocked', () => {
    const a = new ShootoutAudio();
    a.unlock();
    expect(() => { a.whistle(); a.tick(); a.kick(); a.cheer(); a.cheer(0.5); a.save(); a.groan(); a.groan(0.4); a.win(); }).not.toThrow();
    expect(nodesCreated).toBeGreaterThan(10);
  });

  it('stays silent when muted, and remembers the choice', () => {
    const a = new ShootoutAudio();
    a.unlock();
    a.setMuted(true);
    const before = nodesCreated;
    a.whistle(); a.kick(); a.cheer(); a.groan(); a.win();
    expect(nodesCreated).toBe(before);
    expect(new ShootoutAudio().muted).toBe(true);
    a.setMuted(false);
    expect(new ShootoutAudio().muted).toBe(false);
  });

  it('vibration is optional and never throws', () => {
    const a = new ShootoutAudio();
    expect(() => a.buzz([10, 20])).not.toThrow();
  });
});
