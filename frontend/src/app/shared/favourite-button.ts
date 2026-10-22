import { Component, inject, input } from '@angular/core';
import { Favourite, Favourites } from '../core/favourites';

@Component({
  selector: 'app-favourite-button',
  template: `<button type="button" class="btn btn-sm" [attr.aria-pressed]="store.has(kind(), id())" (click)="store.toggle({kind: kind(), id: id(), name: name()})">{{ store.has(kind(), id()) ? '★ Following' : '☆ Follow' }} {{ name() }}</button>@if (store.warning()) { <p role="status">{{ store.warning() }}</p> }`,
  styles: [`:host { max-width:100%; } button { max-width:100%; white-space:normal; text-align:left; overflow-wrap:anywhere; }`],
})
export class FavouriteButton {
  protected store = inject(Favourites);
  readonly kind = input<Favourite['kind']>('team');
  readonly id = input.required<number>();
  readonly name = input.required<string>();
}
