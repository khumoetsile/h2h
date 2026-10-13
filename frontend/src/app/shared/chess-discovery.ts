import { Component, input } from '@angular/core';
import { Game } from '../core/models';
import { GameDiscovery } from './game-discovery';

@Component({
  selector:'app-chess-discovery',
  imports:[GameDiscovery],
  template:'<app-game-discovery [gamePool]="gamePool()" [loadFromApi]="loadFromApi()" />',
  styles:[':host {display:block;min-width:0;}'],
})
export class ChessDiscovery {
  readonly gamePool=input<Game[]|null>(null);
  readonly loadFromApi=input(true);
}
