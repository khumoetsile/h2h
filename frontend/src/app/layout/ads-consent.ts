import { Component, inject } from '@angular/core';
import { AdsService } from '../core/ads.service';

/** A small card, not a wall: it asks once, and the app works the same whichever button is pressed. */
@Component({
  selector: 'app-ads-consent',
  template: `
    @if (ads.needsConsent()) {
      <section class="consent" role="dialog" aria-label="Ads">
        <p>Head2Head shows a few ads to stay free. May we use cookies to make them relevant to you?</p>
        <div class="row">
          <button class="btn btn-sm" (click)="ads.setConsent('denied')">No thanks</button>
          <button class="btn btn-primary btn-sm" (click)="ads.setConsent('granted')">Allow</button>
        </div>
      </section>
    }
  `,
  styles: [`
    .consent { position: fixed; left: 12px; right: 12px; bottom: calc(var(--bottom-nav-h, 64px) + 12px + env(safe-area-inset-bottom)); z-index: 60; max-width: 460px; margin: 0 auto;
      background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    p { font-size: 15px; line-height: 1.4; margin: 0 0 10px; }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    @media (min-width: 900px) { .consent { bottom: 16px; left: auto; right: 16px; margin: 0; } }
  `],
})
export class AdsConsent {
  protected ads = inject(AdsService);
}
