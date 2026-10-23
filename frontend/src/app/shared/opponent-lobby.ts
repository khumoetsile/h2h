import { ExperienceMeasurement } from '../core/experience-measurement';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { interval } from 'rxjs';
import { Api } from '../core/api.service';
import { MoneyPipe } from './pipes';

@Component({
  selector: 'app-opponent-lobby', imports: [RouterLink, MoneyPipe],
  template: `<section class="card lobby"><h2>Find an opponent</h2><p class="muted small">Players waiting for a live game. Entries use demo funds only. Refreshes every 15 seconds.</p>
    @if(error()) { <p role="status">{{ error() }}</p><button class="btn btn-sm" (click)="load()">Retry</button> }
    @if (!loaded() && !error()) { <p role="status">Loading opponents…</p> }
    @for (m of matches(); track m.code) { <div class="opponent"><div><a [routerLink]="['/players',m.username]">{{ m.username }}</a><p>{{ m.game }} · {{ m.stake | money }} demo</p></div><a class="btn btn-sm" [routerLink]="['/join',m.code]">Review</a></div> }
    @if(loaded() && !error() && !matches().length) { <p class="muted">No players are waiting right now. You can still create an invitation and send it to a friend.</p> }
    <div class="lobby-actions"><a class="btn btn-primary" routerLink="/games" (click)="measurement.record('empty_recovery','challenges')">Create a challenge</a><a class="btn" routerLink="/games/penalty-shootout" [queryParams]="{mode:'invite'}">Invite a friend</a></div><a routerLink="/daily-predictions">Try a free daily prediction →</a><a routerLink="/games">Choose another game →</a><a routerLink="/football">Football opponent lobby →</a></section>`,
  styles: [`.lobby {margin-bottom:16px;display:flex;flex-direction:column;gap:10px} .lobby-actions{display:flex;flex-wrap:wrap;gap:8px}.opponent {display:flex;align-items:center;justify-content:space-between;gap:12px;overflow-wrap:anywhere}`],
})
export class OpponentLobby implements OnInit {
  private api = inject(Api);
  protected measurement = inject(ExperienceMeasurement);
  private destroyRef = inject(DestroyRef);
  protected matches = signal<{code:string; username:string; game:string; stake:number}[]>([]);
  protected loaded = signal(false);
  protected error = signal('');
  private loading = false;
  ngOnInit() { void this.load(); interval(15000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.load()); }
  protected async load() {
    if (this.loading) return;
    this.loading = true;
    try { this.matches.set((await this.api.get<{matches: {code:string; username:string; game:string; stake:number}[]}>('/matches/lobby')).matches); this.loaded.set(true); this.error.set(''); }
    catch { this.error.set('Could not refresh waiting opponents.'); this.matches.set([]); }
    finally { this.loading = false; }
  }
}
