import { Component, computed, input } from '@angular/core';

/** Original vector pieces: consistent, crisp and independent of device chess fonts. */
@Component({
  selector: 'app-chess-piece',
  template: `
    @if (piece()) {
      <svg viewBox="0 0 64 64" aria-hidden="true" [class.white]="white()" [class.black]="!white()">
        <g class="body" stroke-linejoin="round" stroke-linecap="round">
          @switch (kind()) {
            @case ('p') { <circle cx="32" cy="19" r="8"/><path d="M26 27h12l-2 8 7 13H21l7-13z"/> }
            @case ('r') { <path d="M18 13h7v7h7v-7h7v7h7v-7h1v15H17V13h1zm5 15h18l-3 16H26z"/> }
            @case ('n') { <path d="M19 46l4-13-8-4 12-17 2-6 7 6 8 6 3 13-6 15z"/><path class="detail" d="M23 29l10-10m1 14-6 12"/><circle class="eye" cx="35" cy="19" r="2"/> }
            @case ('b') { <path d="M32 8c-6 7-13 13-13 20 0 6 5 9 13 9s13-3 13-9c0-7-7-13-13-20zm-6 29h12l5 10H21z"/><path class="detail" d="M35 17l-8 13"/> }
            @case ('q') { <path d="M17 20l7 8 8-14 8 14 7-8-5 21H22zM24 41h16l4 7H20z"/><circle cx="16" cy="17" r="3"/><circle cx="32" cy="11" r="3"/><circle cx="48" cy="17" r="3"/> }
            @case ('k') { <path d="M29 7h6v7h6v6h-6v5h-6v-5h-6v-6h6zM20 28c-6-10 10-15 12-2 2-13 18-8 12 2l-6 13H26zM26 41h12l6 7H20z"/> }
          }
          <path d="M19 48h26l3 7H16z"/>
        </g>
      </svg>
    }
  `,
  styles: [`
    :host { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; pointer-events: none; }
    svg { width: 91%; height: 91%; overflow: visible; filter: drop-shadow(0 2px 1px #0003); }
    .body { stroke-width: 2.2; }
    .white .body { fill: #fff6df; stroke: #514938; }
    .black .body { fill: #242f29; stroke: #efe8d8; }
    .detail { fill: none; stroke-width: 2.4; }
    .white .eye { fill: #514938; stroke: none; }
    .black .eye { fill: #efe8d8; stroke: none; }
  `],
})
export class ChessPiece {
  readonly piece = input<string | null>(null);
  protected kind = computed(() => this.piece()?.toLowerCase());
  protected white = computed(() => !!this.piece() && this.piece() === this.piece()!.toUpperCase());
}
