import { Component, computed, inject } from '@angular/core';
import { ConfigStore } from '../core/config.store';
import { formatRemaining } from '../core/server-clock';
import { RealtimeService } from '../core/realtime.service';

/**
 * Global, plain-language network status banner. Mounted once at the app
 * root so it covers every screen — including the full-screen game and
 * result pages that have no header/nav of their own.
 *
 * Never shows a technical detail (no WebSocket errors, HTTP codes, host
 * names). A brief blip shows a soft "unstable" notice; a longer outage
 * shows CONNECTION LOST with the reconnection window counting down. That
 * window is the server's: if you owe an action in a challenge, the server
 * holds your timeout until it closes — a short drop is never treated as
 * abandoning, and never costs the abandonment fee.
 */
@Component({
  selector: 'app-connection-banner',
  template: `
    @if (rt.connectionState() === 'unstable') {
      <div class="conn-banner unstable" role="status" aria-live="polite">
        <span class="spin"></span> Connection unstable — we're trying to keep you connected.
      </div>
    }
    @if (rt.connectionState() === 'lost') {
      <div class="conn-banner lost" role="status" aria-live="assertive">
        <span class="spin"></span>
        <span><strong>CONNECTION LOST</strong> — we're trying to reconnect you.</span>
        @if (windowLeft() > 0) { <span class="clock">{{ clock() }}</span> }
        @else { <span>Still trying… your challenge timers keep running on the server.</span> }
      </div>
    }
    @if (rt.justRestored() && rt.connectionState() === 'online') {
      <div class="conn-banner restored" role="status" aria-live="polite">
        You're back online — your challenge continues.
      </div>
    }
  `,
})
export class ConnectionBanner {
  protected rt = inject(RealtimeService);
  private config = inject(ConfigStore);
  /** Seconds left of the reconnection window. Measured locally — while offline we can't ask the server. */
  protected windowLeft = computed(() => (this.config.timers()?.reconnectionSeconds ?? 60) - this.rt.offlineSeconds());
  protected clock = computed(() => formatRemaining(Math.max(0, this.windowLeft()) * 1000));
}
