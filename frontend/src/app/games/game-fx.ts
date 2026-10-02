import { ShootoutAudio } from './shootout-audio';

/**
 * Shared polish for the quick games: synthesised sounds (no files to download) and little DOM effects
 * (particles, floating points, a shake, a colour flash) that clean up after themselves. Everything is
 * skipped for people who ask their phone to reduce motion, and sound only plays after a tap.
 */
export class GameAudio extends ShootoutAudio {
  private blip(freq: number, to: number, dur: number, type: OscillatorType, peak: number, at = 0) {
    if (!this.ready()) return;
    const ctx = this.ctx!; const t = ctx.currentTime + at;
    const g = ctx.createGain(); g.connect(this.master!);
    this.env(g, t, peak, 0.004, dur * 0.3, dur * 0.7);
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    o.connect(g); o.start(t); o.stop(t + dur + 0.05);
  }

  /** Something appeared. */
  pop() { this.blip(520, 980, 0.09, 'sine', 0.18); }
  /** The countdown's last beat, higher than the others. */
  go() { this.blip(1175, 1175, 0.16, 'triangle', 0.2); }
  /** A good hit. `q` is 0 (barely) to 1 (perfect): better is higher and brighter. */
  hit(q = 0.5) {
    const base = 520 + q * 420;
    this.blip(base, base * 1.01, 0.12, 'triangle', 0.2);
    this.blip(base * 1.5, base * 1.5, 0.18, 'triangle', 0.14, 0.07);
    if (q > 0.85) this.blip(base * 2, base * 2, 0.22, 'sine', 0.1, 0.14);
  }
  /** A miss: a soft low thud. */
  miss() { this.blip(200, 80, 0.16, 'triangle', 0.22); }
  /** Something done wrong (a false start, a wrong card): a short buzz. */
  wrong() { this.blip(150, 110, 0.22, 'sawtooth', 0.12); }
  /** A run of good ones. */
  streak(n: number) {
    const base = 600 + Math.min(n, 8) * 40;
    [0, 0.07, 0.14].forEach((d, i) => this.blip(base * (1 + i * 0.25), base * (1 + i * 0.25), 0.12, 'triangle', 0.14, d));
  }
  /** Tapping a tile or a key. */
  tap(i = 0) { this.blip(420 + (i % 7) * 70, 420 + (i % 7) * 70, 0.07, 'sine', 0.14); }
}

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A puff of dots flying out from (x, y) in the host's own pixels. */
export function burst(host: HTMLElement, x: number, y: number, color: string, count = 10) {
  if (reduced()) return;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    Object.assign(p.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: '6px', height: '6px', borderRadius: '50%', background: color, pointerEvents: 'none', zIndex: '6' });
    host.appendChild(p);
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const d = 34 + Math.random() * 46;
    const anim = p.animate(
      [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(.2)`, opacity: 0 }],
      { duration: 380 + Math.random() * 200, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    anim.onfinish = () => p.remove();
  }
}

/** A ring that grows and fades at (x, y). */
export function ripple(host: HTMLElement, x: number, y: number, color: string, size = 70) {
  if (reduced()) return;
  const r = document.createElement('i');
  Object.assign(r.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px`, borderRadius: '50%', border: `3px solid ${color}`, pointerEvents: 'none', zIndex: '5' });
  host.appendChild(r);
  r.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.9 }, { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 0 }], { duration: 480, easing: 'ease-out' }).onfinish = () => r.remove();
}

/** Text that floats up and fades: "+840", "Bullseye". */
export function floatText(host: HTMLElement, x: number, y: number, text: string, color: string, size = 24) {
  const el = document.createElement('b');
  el.textContent = text;
  Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, color, fontFamily: 'var(--font-display)', fontSize: `${size}px`, fontWeight: '700', pointerEvents: 'none', zIndex: '7', textShadow: '0 2px 0 rgba(0,0,0,.5)', whiteSpace: 'nowrap' });
  host.appendChild(el);
  if (reduced()) { setTimeout(() => el.remove(), 700); return; }
  el.animate([{ transform: 'translate(-50%,-50%) scale(.8)', opacity: 0 }, { transform: 'translate(-50%,-90%) scale(1.1)', opacity: 1, offset: 0.2 }, { transform: 'translate(-50%,-220%) scale(1)', opacity: 0 }], { duration: 850, easing: 'ease-out' }).onfinish = () => el.remove();
}

export function shake(el: HTMLElement) {
  if (reduced()) return;
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(9px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(0)' }], { duration: 280 });
}

/** A quick wash of colour over the whole host. */
export function flash(host: HTMLElement, color: string, peak = 0.3) {
  if (reduced()) return;
  const f = document.createElement('div');
  Object.assign(f.style, { position: 'absolute', inset: '0', background: color, opacity: '0', pointerEvents: 'none', zIndex: '4' });
  host.appendChild(f);
  f.animate([{ opacity: 0 }, { opacity: peak, offset: 0.25 }, { opacity: 0 }], { duration: 360 }).onfinish = () => f.remove();
}

export const buzz = (pattern: number | number[]) => { try { navigator.vibrate?.(pattern); } catch { /* not supported */ } };
