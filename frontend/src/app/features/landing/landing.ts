import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { apiError } from '../../core/api-error';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { QuickPlay } from '../../core/quick-play';
import { PitchArt } from '../../shared/pitch-art';
import { ChessArt } from '../../shared/chess-art';

/**
 * What a stranger sees first. One promise, one button. Tapping Play creates a guest account behind the scenes
 * and puts them in a penalty shootout; nobody fills in a form before they have had a go.
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatProgressSpinnerModule, PitchArt, ChessArt],
  template: `
    <main class="land">
      <header class="land-nav"><div class="brand"><span aria-hidden="true">//</span> Head2Head</div><a routerLink="/login">Sign in <span aria-hidden="true">↗</span></a></header>
      <div class="intro"><span class="eyebrow">A little competition. A lasting rivalry.</span><h1>Your people.<br><span>Your next rivalry.</span></h1><p class="lead">A quick shootout or a thoughtful game of chess. Challenge someone and make your next move.</p></div>
      <div class="modes">
        <section class="mode"><app-pitch-art class="art" /><div class="mode-copy"><span class="eyebrow">Play live · About two minutes</span><h2>Meet on the pitch.</h2><p>Take turns shooting and saving against another player.</p><button class="btn btn-primary btn-block" [disabled]="busy()" (click)="play()">@if(busy()) { <mat-spinner diameter="24" /> } @else { Set up a shootout <span aria-hidden="true">→</span> }</button></div></section>
        <section class="mode chess"><app-chess-art class="art" /><div class="mode-copy"><span class="eyebrow">Play across days · New</span><h2>Think. Move. Return.</h2><p>Invite a friend to chess. Save each move and return before your next deadline.</p><a class="btn btn-block" routerLink="/chess">Explore chess <span aria-hidden="true">→</span></a></div></section>
      </div>
      @if (error()) { <p class="form-error" role="alert">{{ error() }}</p> }
      <p class="demo-note">Start with {{ bonus() }} in demo funds. Review every entry before playing. No real money.</p>
      <footer class="land-footer"><a routerLink="/football">Football fixtures &amp; scores</a><a routerLink="/help">How to play &amp; help</a></footer>
    </main>
  `,
  styles: [`
    .land { min-height:100dvh; max-width:1060px; margin:0 auto; padding:24px 24px calc(24px + env(safe-area-inset-bottom)); }
    .land-nav {display:flex;align-items:center;justify-content:space-between;gap:16px;}.brand {font-family:var(--font-display);font-size:28px;font-weight:700;}.brand span {color:var(--accent);}.land-nav a {min-height:44px;display:flex;align-items:center;gap:16px;color:var(--text-2);font-weight:600;}
    .intro {padding:44px 0 32px;max-width:700px;}.eyebrow {font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);font-weight:700;}h1 {font-size:clamp(48px,7vw,76px);line-height:.98;letter-spacing:-.02em;margin:14px 0 20px;}h1 span {color:#d8c68e;}.lead {color:var(--text-2);font-size:19px;max-width:600px;line-height:1.5;}
    .modes {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;}.mode {background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;display:flex;flex-direction:column;}.mode-copy {padding:24px;display:flex;flex-direction:column;gap:10px;flex:1;}h2 {font-size:32px;line-height:1.1;}.mode p {color:var(--text-2);line-height:1.5;flex:1;}.mode .btn {margin-top:10px;justify-content:space-between;}.art {width:100%;height:220px;overflow:hidden;}.chess {background:radial-gradient(ellipse at 70% 0%,#3b584044,transparent 70%),#1a2b23;border-color:#4d6551;}.chess .eyebrow {color:#dfc683;}.chess .btn {border-color:#94a489;background:#d8c68e;color:#1a241d;}
    .demo-note {text-align:center;color:var(--muted);font-size:14px;margin:24px 0 12px;}.land-footer {display:flex;justify-content:center;gap:24px;flex-wrap:wrap;}.land-footer a {display:flex;align-items:center;min-height:44px;font-size:14px;color:var(--text-2);text-decoration:underline;}
    @media(max-width:600px) {.land {padding:20px 16px;}.intro {padding:32px 0 24px;}.lead {font-size:17px;}.modes {grid-template-columns:minmax(0,1fr);gap:16px;}.mode-copy {padding:20px;}.art {height:180px;}h2 {font-size:28px;} }
  `],
})
export class LandingPage {
  private quick = inject(QuickPlay);
  private config = inject(ConfigStore);

  protected busy = signal(false);
  protected error = signal('');
  protected bonus = computed(() => formatMoney(this.config.config()?.signupBonus ?? 250));

  protected async play() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.quick.playNow();
    } catch (err) {
      this.error.set(apiError(err).message);
      this.busy.set(false);
    }
  }
}
