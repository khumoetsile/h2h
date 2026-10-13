import { Component, computed, inject } from '@angular/core';
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
        <span class="spin"></span> Live updates paused. Reconnecting…
      </div>
    }
    @if (rt.connectionState() === 'lost') {
      <div class="conn-banner lost" role="status" aria-live="assertive">
        <span class="spin"></span>
        <span><strong>Live connection interrupted</strong>. Keep this page open while we reconnect. Match timers keep running.</span>
        <span class="clock">Reconnecting {{ clock() }}</span>
      </div>
    }
    @if (rt.justRestored() && rt.connectionState() === 'online') {
      <div class="conn-banner restored" role="status" aria-live="polite">
        Live updates restored. Your match status is refreshing.
      </div>
    }
  `,
})
export class ConnectionBanner {
  protected rt = inject(RealtimeService);
  /** Elapsed reconnect time; this never claims to be a server match deadline. */
  protected clock = computed(() => formatRemaining(this.rt.offlineSeconds() * 1000));
}
