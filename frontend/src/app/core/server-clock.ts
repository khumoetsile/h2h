import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api.service';

const RESYNC_MS = 60_000;

/**
 * The server's clock, as seen from this browser — for DISPLAY ONLY.
 *
 * Every deadline comes from the server; this just estimates "what time is
 * it on the server right now" so countdowns are accurate. It's anchored to
 * performance.now(), which is monotonic: changing the device's system clock
 * (or its timezone) mid-challenge does not move any countdown. And nothing
 * here can extend a timer — the server enforces every deadline itself.
 */
@Injectable({ providedIn: 'root' })
export class ServerClock {
  private api = inject(Api);
  private anchorServerMs = Date.now();
  private anchorPerf = performance.now();
  private bestRtt = Number.POSITIVE_INFINITY;
  private lastSync = 0;

  /** Server-time "now" in ms, ticking once a second. Read it inside computed()/templates. */
  readonly now = signal(this.read());

  constructor() {
    setInterval(() => {
      this.now.set(this.read());
      if (performance.now() - this.lastSync > RESYNC_MS) this.sync();
    }, 1000);
    this.sync();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sync(true); });
    }
  }

  private read() {
    return this.anchorServerMs + (performance.now() - this.anchorPerf);
  }

  /** Estimate the offset from a round trip to /api/time (midpoint method). */
  async sync(force = false) {
    this.lastSync = performance.now();
    try {
      const t0 = performance.now();
      const { serverNow } = await this.api.get<{ serverNow: string }>('/time');
      const t1 = performance.now();
      const rtt = t1 - t0;
      // Prefer the sample with the smallest round trip; accept a worse one
      // only on a forced resync (e.g. tab became visible again).
      if (!force && rtt > this.bestRtt * 1.5 && Number.isFinite(this.bestRtt)) return;
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.anchorServerMs = new Date(serverNow).getTime() + rtt / 2;
      this.anchorPerf = t1;
      this.now.set(this.read());
    } catch {
      /* keep the previous estimate */
    }
  }

  remainingMs(deadline: string | Date | null | undefined) {
    if (!deadline) return 0;
    return Math.max(0, new Date(deadline).getTime() - this.now());
  }
}

/** "04:32" under an hour, "01h 24m" under a day, "2d 04h" beyond. */
export function formatRemaining(ms: number, style: 'auto' | 'clock' = 'auto') {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  if (style === 'clock' || total < 3600) return `${pad(Math.floor(total / 60))}:${pad(s)}`;
  if (d === 0) return `${pad(h)}h ${pad(m)}m`;
  return `${d}d ${pad(h)}h`;
}
