import { Component } from '@angular/core';

/** Decorative artwork, drawn locally so discovery never depends on remote images. */
@Component({
  selector: 'app-chess-art',
  template: `
    <div class="scene" aria-hidden="true">
      <div class="board"></div><div class="ring"></div>
      <svg class="knight dark" viewBox="0 0 100 120" focusable="false">
        <path d="M22 100h60l-4-12H27zM27 84h47c-3-15-13-20-11-34 12-7 17-20 12-30L66 5l-8 14-16-2-21 25 6 11 16-8 6 9c-4 8-18 12-22 30z" />
        <path class="detail" d="m47 28-7 7m17 3c-5 7-5 17-1 25M25 106h57" />
      </svg>
      <svg class="knight light" viewBox="0 0 100 120" focusable="false">
        <path d="M22 100h60l-4-12H27zM27 84h47c-3-15-13-20-11-34 12-7 17-20 12-30L66 5l-8 14-16-2-21 25 6 11 16-8 6 9c-4 8-18 12-22 30z" />
        <path class="detail" d="m47 28-7 7m17 3c-5 7-5 17-1 25M25 106h57" />
      </svg>
      <span class="spark s1"></span><span class="spark s2"></span>
    </div>
  `,
  styles: [`
    :host { display:block; width:100%; }
    .scene { position:relative; isolation:isolate; width:100%; flex:1; min-height:200px; height:100%; overflow:hidden; }
    .board { position:absolute; width:260px; height:260px; left:50%; top:62%; transform:translate(-50%,-50%) rotate(-24deg) skew(12deg,12deg); background:repeating-conic-gradient(#d8d6b5 0% 25%,#4f7767 0% 50%) 50%/64px 64px; border:10px solid #28443b; border-radius:14px; box-shadow:0 16px 0 #182d26,0 30px 38px #0005; opacity:.65; }
    .knight { position:absolute; width:112px; height:138px; overflow:visible; filter:drop-shadow(0 14px 8px #0005); stroke-linejoin:round; }
    .dark { fill:#203c35; stroke:#7da38e; stroke-width:1.6; left:calc(50% - 94px); top:24px; transform:rotate(-9deg); }
    .light { fill:#efe7ce; stroke:#c5ad77; stroke-width:1.6; left:calc(50% - 2px); top:52px; transform:rotate(8deg); }
    .detail { fill:none; stroke-width:3; stroke-linecap:round; }
    .ring { position:absolute; width:230px; height:230px; border:1px solid #d9b44a33; border-radius:50%; left:50%; top:46%; transform:translate(-50%,-50%); z-index:-1; }
    .spark { position:absolute; width:6px; height:6px; background:#e4c77f; transform:rotate(45deg); }.s1 {left:23%;top:19%;}.s2 {right:17%;top:34%;width:4px;height:4px;}
    @media(prefers-reduced-motion: no-preference) { .knight { transition:transform .25s; } :host:hover .light { transform:translateY(-4px) rotate(8deg); } }
  `],
})
export class ChessArt {}
