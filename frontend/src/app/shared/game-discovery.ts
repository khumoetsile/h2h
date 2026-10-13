import { AfterViewInit, Component, DestroyRef, ElementRef, OnInit, ViewChild, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Game } from '../core/models';
import { GameCatalogue, discoveryGames } from '../core/game-catalogue';
import { QuickPlay } from '../core/quick-play';
import { apiError } from '../core/api-error';
import { ChessArt } from './chess-art';
import { PitchArt } from './pitch-art';
import { GameIcon } from './ui';

interface DiscoveryCard { slug:string; name:string; tagline:string; accentColor:string; estimatedDurationSeconds:number; }
const CHESS: DiscoveryCard = {slug:'chess',name:'Chess, on your schedule.',tagline:'Challenge a friend. Save each turn. Return before your next deadline.',accentColor:'#d8c68e',estimatedDurationSeconds:0};

@Component({
  selector: 'app-game-discovery',
  imports: [RouterLink, ChessArt, PitchArt, GameIcon],
  template: `
    <section class="discovery" role="region" aria-roledescription="carousel" aria-label="Featured games">
      <div #rail class="rail" (scroll)="scrolled()">
        @for (game of cards(); track game.slug; let i=$index) {
          <article class="slide" [class.chess]="game.slug === 'chess'" [style.--game-accent]="game.accentColor" role="group" aria-roledescription="slide" [attr.aria-label]="(i+1)+' of '+cards().length+': '+game.name" [attr.aria-hidden]="active() !== i">
            <div class="copy"><span class="eyebrow">{{ game.slug === 'chess' ? 'Play across days · Chess' : 'Play live · '+duration(game) }}</span><h2>{{ game.name }}</h2><p>{{ game.tagline }}</p>
              @if (game.slug === 'chess') { <a class="btn btn-primary" routerLink="/chess" [tabIndex]="active()===i ? 0 : -1">Explore chess <span aria-hidden="true">↗</span></a> }
              @else { <button type="button" class="btn btn-primary" [disabled]="!!busy()" [tabIndex]="active()===i ? 0 : -1" (click)="play(game)">{{ busy()===game.slug ? 'Opening setup…' : 'Set up a match' }}<span aria-hidden="true">↗</span></button> }
              <span class="note">{{ game.slug==='chess' ? 'Saved turns. A deadline for every move.' : 'Review your demo entry before playing.' }}</span>
            </div>
            <div class="art" aria-hidden="true">
              @if (game.slug==='chess') { <app-chess-art /> }
              @else if (game.slug==='penalty-shootout') { <app-pitch-art /> }
              @else { <div class="game-orbit"><span class="orbit o1"></span><span class="orbit o2"></span><app-game-icon [slug]="game.slug" [color]="game.accentColor" [size]="104" /><span class="art-label">{{ game.name }}</span></div> }
            </div>
          </article>
        }
      </div>
      <div class="controls">
        <span class="position" aria-live="polite" aria-atomic="true">{{ active()+1 }} / {{ cards().length }} <span class="muted">· {{ active()===0 ? 'Chess' : cards()[active()]?.name }}</span></span>
        <div class="buttons"><button type="button" class="arrow" aria-label="Previous featured game" [disabled]="cards().length<2" (click)="go(active()-1)">←</button><div class="dots" role="group" aria-label="Choose a featured game">@for (game of cards();track game.slug;let i=$index) { <button type="button" class="dot" [class.current]="active()===i" [attr.aria-label]="'Show '+(i===0 ? 'Chess' : game.name)" [attr.aria-pressed]="active()===i" (click)="go(i)"><span></span></button> }</div><button type="button" class="arrow" aria-label="Next featured game" [disabled]="cards().length<2" (click)="go(active()+1)">→</button></div>
      </div>
      @if (error()) { <div class="discovery-error" role="status">{{ error() }}<button type="button" class="link" (click)="load()">Try again</button></div> }
    </section>
  `,
  styleUrl: './game-discovery.scss',
})
export class GameDiscovery implements OnInit, AfterViewInit {
  readonly gamePool = input<Game[]|null>(null);
  readonly loadFromApi = input(true);
  @ViewChild('rail') private rail?:ElementRef<HTMLDivElement>;
  private catalogue = inject(GameCatalogue);
  private quick = inject(QuickPlay);
  private destroyRef = inject(DestroyRef);
  protected cards = signal<DiscoveryCard[]>([CHESS]);
  protected active = signal(0);
  protected busy = signal('');
  protected error = signal('');
  private picked:string[]=[];
  private scrollTimer?:ReturnType<typeof setTimeout>;
  constructor() {
    effect(() => { const pool=this.gamePool(); if(pool) this.setGames(pool); });
    this.destroyRef.onDestroy(() => clearTimeout(this.scrollTimer));
  }
  ngOnInit() { if(this.loadFromApi() && !this.gamePool()) void this.load(); }
  ngAfterViewInit() {
    if(typeof ResizeObserver!=='undefined' && this.rail) { const observer=new ResizeObserver(()=>this.scrollTo(this.active(),false));observer.observe(this.rail.nativeElement);this.destroyRef.onDestroy(()=>observer.disconnect()); }
  }
  private setGames(games:Game[]) { const chosen=discoveryGames(games,this.picked);this.picked=chosen.map(g=>g.slug);this.cards.set([CHESS,...chosen]);if(this.active()>=this.cards().length) this.go(0); }
  async load() { this.error.set('');try {this.setGames(await this.catalogue.load());}catch {this.error.set('More games could not load.');} }
  protected duration(game:DiscoveryCard) {const minutes=Math.max(1,Math.ceil(game.estimatedDurationSeconds/60));return 'About '+minutes+(minutes===1?' minute':' minutes');}
  protected go(index:number) { const next=(index+this.cards().length)%this.cards().length; this.active.set(next);this.scrollTo(next,true); }
  private scrollTo(index:number,smooth:boolean) { const rail=this.rail?.nativeElement;if(!rail)return;const left=rail.clientWidth*index;const behavior=smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth':'auto';if(rail.scrollTo)rail.scrollTo({left,behavior});else rail.scrollLeft=left; }
  protected scrolled() {clearTimeout(this.scrollTimer);this.scrollTimer=setTimeout(()=>{const rail=this.rail?.nativeElement;if(rail?.clientWidth)this.active.set(Math.max(0,Math.min(this.cards().length-1,Math.round(rail.scrollLeft/rail.clientWidth))));},120);}
  protected async play(game:DiscoveryCard) {if(this.busy())return;this.busy.set(game.slug);this.error.set('');try{await this.quick.playNow(game.slug);}catch(err){this.error.set(apiError(err).message);}finally{this.busy.set('');}}
}
