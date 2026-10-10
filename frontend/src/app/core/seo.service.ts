import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { BRAND } from './brand';

@Injectable({ providedIn: 'root' })
export class SeoService {
  private document = inject(DOCUMENT);
  private meta = inject(Meta);
  private title = inject(Title);

  publish(title: string, description: string, path: string, index = true) {
    this.title.setTitle(`${title} · ${BRAND.name} (Demo)`);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ name: 'robots', content: index ? 'index,follow' : 'noindex,nofollow' });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: 'website' });

    const location = this.document.defaultView?.location;
    if (!location) return;
    const canonicalUrl = new URL(path, location.origin).toString();
    let canonical = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = this.document.createElement('link');
      canonical.rel = 'canonical';
      this.document.head.appendChild(canonical);
    }
    canonical.href = canonicalUrl;
    this.meta.updateTag({ property: 'og:url', content: canonicalUrl });
  }
}
