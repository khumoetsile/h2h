/**
 * Tiny synthesised sound effects for the shootout (Web Audio, no files to
 * download). Browsers only allow audio after a tap, so nothing plays until
 * unlock() has been called from a user gesture. Mute is remembered.
 */
const KEY = 'h2h.sound';

export class ShootoutAudio {
  protected ctx: AudioContext | null = null;
  protected master: GainNode | null = null;
  muted = false;

  constructor() {
    try { this.muted = localStorage.getItem(KEY) === 'off'; } catch { /* storage unavailable */ }
  }

  setMuted(v: boolean) {
    this.muted = v;
    try { localStorage.setItem(KEY, v ? 'off' : 'on'); } catch { /* storage unavailable */ }
  }

  /** Call from a pointer event. Creates / resumes the audio context. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch { /* audio is a bonus, never an error */ }
  }

  protected ready() { return !this.muted && !!this.ctx && !!this.master && this.ctx.state === 'running'; }

  protected noise(seconds: number) {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  protected env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  /** Referee's whistle: two close tones with a flutter. */
  whistle() {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.master!);
    this.env(g, t, 0.22, 0.02, 0.22, 0.12);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 26;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    for (const f of [2850, 3050]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 0.5);
    }
    lfo.start(t); lfo.stop(t + 0.5);
  }

  /** A short blip for the countdown. */
  tick() {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.master!);
    this.env(g, t, 0.12, 0.005, 0.02, 0.06);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 880; o.connect(g); o.start(t); o.stop(t + 0.12);
  }

  /** The strike: a low thump with a snap of air. */
  kick() {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const g = ctx.createGain(); g.connect(this.master!);
    this.env(g, t, 0.7, 0.004, 0.02, 0.16);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.14);
    o.connect(g); o.start(t); o.stop(t + 0.22);
    const n = this.noise(0.08); const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 1800;
    const ng = ctx.createGain(); this.env(ng, t, 0.25, 0.002, 0.01, 0.06);
    n.connect(nf); nf.connect(ng); ng.connect(this.master!); n.start(t); n.stop(t + 0.1);
  }

  /** The crowd going up: a swelling wash of filtered noise. */
  cheer(level = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const n = this.noise(2.2);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.55;
    const g = ctx.createGain(); this.env(g, t, 0.5 * level, 0.35, 0.5, 1.2);
    n.connect(bp); bp.connect(g); g.connect(this.master!); n.start(t); n.stop(t + 2.2);
    const o = ctx.createOscillator(); o.type = 'triangle'; const og = ctx.createGain(); this.env(og, t, 0.05, 0.3, 0.3, 0.8);
    o.frequency.setValueAtTime(330, t); o.frequency.linearRampToValueAtTime(440, t + 0.8);
    o.connect(og); og.connect(this.master!); o.start(t); o.stop(t + 1.5);
  }

  /** Keeper's gloves on the ball. */
  save() {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const n = this.noise(0.12); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain(); this.env(g, t, 0.55, 0.003, 0.02, 0.1);
    n.connect(lp); lp.connect(g); g.connect(this.master!); n.start(t); n.stop(t + 0.14);
  }

  /** The crowd's disappointment: a falling murmur. */
  groan(level = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.7);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const g = ctx.createGain(); this.env(g, t, 0.13 * level, 0.08, 0.2, 0.6);
    o.connect(lp); lp.connect(g); g.connect(this.master!); o.start(t); o.stop(t + 1);
  }

  /** Short rising chime when a shootout is won. */
  win() {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain(); this.env(g, t + i * 0.1, 0.16, 0.01, 0.08, 0.3);
      o.connect(g); g.connect(this.master!); o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.5);
    });
  }

  buzz(pattern: number | number[]) {
    try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
  }
}
