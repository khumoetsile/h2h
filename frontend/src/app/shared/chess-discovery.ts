import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ChessArt } from './chess-art';

@Component({
  selector: 'app-chess-discovery',
  imports: [RouterLink, ChessArt],
  template: `
    <section class="chess-feature" aria-labelledby="chess-discovery-title">
      <div class="copy">
        <span class="eyebrow">New · Correspondence chess</span>
        <h2 id="chess-discovery-title">Chess, on your schedule.</h2>
        <p>Challenge a friend, save each turn, and come back to the board. Every move has a clear deadline.</p>
        <a class="btn btn-primary" routerLink="/chess">Explore chess <span aria-hidden="true">↗</span></a>
        <span class="note">Two players. One board. Play across days.</span>
      </div>
      <app-chess-art />
    </section>
  `,
  styles: [`
    :host { display:block; }
    .chess-feature { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); min-height:280px; border:1px solid #6d8c764d; border-radius:var(--radius-lg); overflow:hidden; background:radial-gradient(ellipse at 80% 10%,#496a4b55,transparent 70%),#1a2d25; box-shadow:0 12px 30px #0002; }
    .copy { position:relative; z-index:1; padding:28px; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; }
    .eyebrow { color:#dfc683; font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
    h2 { font-size:clamp(30px,3vw,42px); line-height:1.08; margin:12px 0; color:#f1ebd9; }
    p { color:#c3d2c6; line-height:1.55; max-width:380px; font-size:16px; }
    .btn { margin-top:20px; gap:18px; } .note { display:block; color:#b8c9be; font-size:13px; margin-top:12px; }
    app-chess-art { display:flex; align-items:center; }
    @media(max-width:560px) { .chess-feature { grid-template-columns:minmax(0,1fr); }.copy { padding:22px; } app-chess-art { grid-row:1; height:185px; }.copy h2 {font-size:32px;} .btn {width:100%;} }
  `],
})
export class ChessDiscovery {}
