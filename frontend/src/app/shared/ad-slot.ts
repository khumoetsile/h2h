import { AfterViewInit, Component, computed, ElementRef, inject, input } from '@angular/core';
import { AdsService } from '../core/ads.service';
import { AuthService } from '../core/auth.service';

const ONE_DAY = 24 * 60 * 60 * 1000;

/** One labelled, fixed-height ad. Draws nothing unless ads are set up, consented to, and the account is past its first day. */
@Component({
  selector: 'app-ad-slot',
  template: `
    @if (show()) {
      <aside class="ad" aria-label="Advertisement">
        <span class="tag">Advertisement</span>
        <ins class="adsbygoogle" style="display:block" [attr.data-ad-client]="client()" [attr.data-ad-slot]="slotId()" data-ad-format="auto" data-full-width-responsive="true"></ins>
      </aside>
    }
  `,
  styles: [`
    :host { display: block; }
    .ad { min-height: 120px; padding: 6px 0; text-align: center; overflow: hidden; }
    .tag { display: block; color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 4px; }
  `],
})
export class AdSlot implements AfterViewInit {
  private ads = inject(AdsService);
  private auth = inject(AuthService);
  private host = inject(ElementRef<HTMLElement>);

  /** Which placement this is; the matching slot ID comes from the server. */
  readonly slot = input<'home' | 'list'>('home');

  protected client = computed(() => this.ads.settings()?.client ?? '');
  protected slotId = computed(() => this.ads.settings()?.slots?.[this.slot()] ?? '');
  protected show = computed(() => {
    if (!this.ads.ready() || !this.slotId() || this.auth.isAdmin()) return false;
    const created = Date.parse(this.auth.user()?.createdAt ?? '');
    return Number.isFinite(created) && Date.now() - created > ONE_DAY;
  });

  ngAfterViewInit() {
    this.ads.ensureScript();
    if (!this.show()) return;
    // Ask Google to fill the slot we just drew.
    setTimeout(() => {
      try {
        if (this.host.nativeElement.querySelector('ins.adsbygoogle')) ((window.adsbygoogle = window.adsbygoogle || []) as unknown[]).push({});
      } catch { /* an ad blocker or a closed network: the slot stays empty */ }
    }, 0);
  }
}
