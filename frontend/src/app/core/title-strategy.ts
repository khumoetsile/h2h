import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { BRAND } from './brand';

@Injectable()
export class BrandTitleStrategy extends TitleStrategy {
  private title = inject(Title);
  override updateTitle(snapshot: RouterStateSnapshot) {
    const t = this.buildTitle(snapshot);
    this.title.setTitle(t ? `${t} · ${BRAND.name} (Demo)` : `${BRAND.name} (Demo)`);
  }
}
