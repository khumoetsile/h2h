import { computed, inject, Injectable, signal } from '@angular/core';
import { ConfigStore } from './config.store';

const CONSENT_KEY = 'h2h.ads.consent';

declare global {
  interface Window { adsbygoogle?: unknown[] & { requestNonPersonalizedAds?: number } }
}

/**
 * Google ads, kept polite. Ads exist only once the server has an AdSense publisher ID; until then everything
 * here is inert and no Google code is loaded. Rules baked in:
 *  - only on calm pages (home), never in a match room, a game or a result screen,
 *  - never to a brand-new account (the first day is for playing),
 *  - nothing loads until the player has answered the consent question, and "no thanks" gets non-personalised ads,
 *  - fixed-height slots, so the page never jumps when an ad arrives.
 */
@Injectable({ providedIn: 'root' })
export class AdsService {
  private config = inject(ConfigStore);

  readonly consent = signal<'granted' | 'denied' | null>(readConsent());
  readonly settings = computed(() => this.config.config()?.ads ?? null);
  readonly enabled = computed(() => !!this.settings()?.client);
  readonly needsConsent = computed(() => this.enabled() && this.consent() === null);
  readonly ready = computed(() => this.enabled() && this.consent() !== null);

  private scriptRequested = false;

  setConsent(v: 'granted' | 'denied') {
    this.consent.set(v);
    try { localStorage.setItem(CONSENT_KEY, v); } catch { /* storage unavailable */ }
    this.ensureScript();
  }

  /** Load Google's script once, and only after the consent answer. */
  ensureScript() {
    const s = this.settings();
    if (this.scriptRequested || !s?.client || this.consent() === null) return;
    this.scriptRequested = true;
    window.adsbygoogle = window.adsbygoogle || [];
    if (this.consent() === 'denied') window.adsbygoogle.requestNonPersonalizedAds = 1;
    const el = document.createElement('script');
    el.async = true;
    el.crossOrigin = 'anonymous';
    el.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(s.client)}`;
    document.head.appendChild(el);
  }
}

function readConsent(): 'granted' | 'denied' | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch { return null; }
}
