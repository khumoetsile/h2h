import { Component, inject } from '@angular/core';
import { RealtimeService } from '../core/realtime.service';

/**
 * Global, plain-language network status banner. Mounted once at the app
 * root so it covers every screen — including the full-screen game and
 * result pages that have no header/nav of their own.
 *
 * Never shows a technical detail (no WebSocket errors, HTTP codes, host
 * names). A brief blip shows a soft "unstable" notice; a longer outage
 * escalates to "interrupted" with a reconnecting timer. The match itself is
 * never abandoned client-side — the server's own timeouts are what decide
 * an outcome, so a short connection issue can't cost a player the match.
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
        <span class="spin"></span> Connection interrupted — we're trying to reconnect you…
        <span class="clock">{{ clock() }}</span>
      </div>
    }
    @if (rt.justRestored() && rt.connectionState() === 'online') {
      <div class="conn-banner restored" role="status" aria-live="polite">
        You're back online.
      </div>
    }
  `,
})
export class ConnectionBanner {
  protected rt = inject(RealtimeService);
  protected clock() {
    const s = this.rt.offlineSeconds();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}
