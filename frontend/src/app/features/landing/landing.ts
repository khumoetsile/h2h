import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigStore } from '../../core/config.store';
import { formatMoney } from '../../core/format';
import { ChessDiscovery } from '../../shared/chess-discovery';

/**
 * What a stranger sees first. One promise, one button. Tapping Play creates a guest account behind the scenes
 * and puts them in a penalty shootout; nobody fills in a form before they have had a go.
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, ChessDiscovery],
  template: `
    <main class="land">
      <header class="land-nav"><div class="brand"><span aria-hidden="true">//</span> Head2Head</div><a routerLink="/login">Sign in <span aria-hidden="true">↗</span></a></header>
      <div class="intro"><span class="eyebrow">Games. Football. Friendly competition.</span><h1>Your game.<br><span>Your rivals.</span><br>Your next challenge.</h1><p class="lead">Play against real people, explore football analysis, make free predictions and compete on a shared Fantasy Arena slip.</p><div class="hero-actions"><a class="btn btn-primary btn-lg" routerLink="/register">Get started</a><a class="btn btn-lg" routerLink="/football">Explore football free</a></div><p class="small muted">Browse football and competitions without an account. All challenge funds are simulated.</p></div>
      <nav class="feature-grid" aria-label="Explore Head2Head"><a class="card" routerLink="/football"><h2>Football, every day</h2><p>Fixtures, live scores, team form and past meetings.</p><strong>Explore fixtures →</strong></a><a class="card" routerLink="/daily-predictions"><h2>Free daily predictions</h2><p>Win, Draw or Loss. Track verified results and distinct winning and participation streaks.</p><strong>See today's challenge →</strong></a><a class="card" routerLink="/arena"><h2>Fantasy Arena</h2><p>Everyone gets the same fixtures. Review the demo entry and growing prize pool.</p><strong>Browse competitions →</strong></a><a class="card" routerLink="/leaderboard"><h2>Rankings & rivals</h2><p>See records earned through completed matches. Build your own rivalry when you play.</p><strong>View rankings →</strong></a></nav>
      <app-chess-discovery />
      <p class="demo-note">Start with {{ bonus() }} in demo funds. Review every entry before playing. No real money.</p>
      <footer class="land-footer"><a routerLink="/football">Fixtures &amp; scores</a><a routerLink="/football/research">Football research</a><a routerLink="/help">How to play &amp; help</a></footer>
    </main>
  `,
  styles: [`
    .land { min-height:100dvh; max-width:1280px; margin:0 auto; padding:24px 24px calc(24px + env(safe-area-inset-bottom)); }
    .land-nav {display:flex;align-items:center;justify-content:space-between;gap:16px;}.brand {font-family:var(--font-display);font-size:28px;font-weight:700;}.brand span {color:var(--accent);}.land-nav a {min-height:44px;display:flex;align-items:center;gap:16px;color:var(--text-2);font-weight:600;}
    .intro {padding:36px 0 28px;max-width:850px;}.eyebrow {font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);font-weight:700;}h1 {font-size:clamp(40px,5vw,64px);line-height:.98;letter-spacing:-.02em;margin:14px 0 20px;}h1 span {color:#d8c68e;}.lead {color:var(--text-2);font-size:19px;max-width:600px;line-height:1.5;}
    .modes {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;}.mode {background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;display:flex;flex-direction:column;}.mode-copy {padding:24px;display:flex;flex-direction:column;gap:10px;flex:1;}h2 {font-size:32px;line-height:1.1;}.mode p {color:var(--text-2);line-height:1.5;flex:1;}.mode .btn {margin-top:10px;justify-content:space-between;}.art {width:100%;height:220px;overflow:hidden;}.chess {background:radial-gradient(ellipse at 70% 0%,#3b584044,transparent 70%),#1a2b23;border-color:#4d6551;}.chess .eyebrow {color:#dfc683;}.chess .btn {border-color:#94a489;background:#d8c68e;color:#1a241d;}
    .hero-actions {display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 12px}.feature-grid {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:12px 0 30px}.feature-grid a {display:flex;flex-direction:column;gap:12px;min-width:0}.feature-grid h2 {font-size:25px}.feature-grid p {flex:1;color:var(--text-2);font-size:15px}.feature-grid strong {color:var(--accent);font-size:14px}@media(max-width:1000px){.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.feature-grid{grid-template-columns:minmax(0,1fr)}.hero-actions .btn{flex:1 1 100%}}
    .demo-note {text-align:center;color:var(--muted);font-size:14px;margin:24px 0 12px;}.land-footer {display:flex;justify-content:center;gap:24px;flex-wrap:wrap;}.land-footer a {display:flex;align-items:center;min-height:44px;font-size:14px;color:var(--text-2);text-decoration:underline;}
    @media(max-width:600px) {.land {padding:20px 16px;}.intro {padding:32px 0 24px;}.lead {font-size:17px;}.modes {grid-template-columns:minmax(0,1fr);gap:16px;}.mode-copy {padding:20px;}.art {height:180px;}h2 {font-size:28px;} }
  `],
})
export class LandingPage {
  private config = inject(ConfigStore);

  protected bonus = computed(() => formatMoney(this.config.config()?.signupBonus ?? 250));

}
