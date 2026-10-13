import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Api } from '../core/api.service';
import { Game } from '../core/models';
import { GameCatalogue, discoveryGames } from '../core/game-catalogue';
import { QuickPlay } from '../core/quick-play';
import { GameDiscovery } from './game-discovery';

const game=(slug:string,isEnabled=true):Game=>({id:slug.length,slug,name:slug,tagline:'Play a match',description:'',howToPlay:'',mode:'1v1',estimatedDurationSeconds:60,accentColor:'#22d3ee',isEnabled});
const pool=[game('penalty-shootout'),game('reaction-rush'),game('memory-battle'),game('word-battle')];

describe('featured game rotation',()=>{
  it('chooses two distinct enabled games and can vary between visits',()=>{
    const first=discoveryGames(pool,[],()=>0);
    const second=discoveryGames(pool,[],()=>.99);
    expect(new Set(first.map(g=>g.slug)).size).toBe(2);
    expect(second.map(g=>g.slug)).not.toEqual(first.map(g=>g.slug));
    expect(discoveryGames([game('aim-challenge',false),...pool],[],()=>.99).every(g=>g.isEnabled)).toBe(true);
  });
  it('keeps a visitor’s choices through background catalogue updates',()=>{
    const selected=discoveryGames(pool,[],()=>0).map(g=>g.slug);
    expect(discoveryGames([...pool].reverse(),selected,()=>.99).map(g=>g.slug)).toEqual(selected);
  });
  it('shares concurrent public catalogue loads without caching user data',async()=>{
    let resolve!:(value:{games:Game[]})=>void;
    const get=vi.fn(()=>new Promise<{games:Game[]}>(done=>resolve=done));
    TestBed.configureTestingModule({providers:[{provide:Api,useValue:{get}}]});
    const store=TestBed.inject(GameCatalogue);const first=store.load();const second=store.load();
    expect(get).toHaveBeenCalledOnce();resolve({games:pool});
    expect(await first).toEqual(pool);expect(await second).toEqual(pool);await store.load();
    expect(get).toHaveBeenCalledOnce();expect(get).toHaveBeenCalledWith('/game-catalogue');
  });
});

describe('featured carousel controls',()=>{
  let play:ReturnType<typeof vi.fn>;
  let mediaDescriptor:PropertyDescriptor|undefined;
  beforeEach(()=>{
    play=vi.fn().mockResolvedValue(undefined);
    mediaDescriptor=Object.getOwnPropertyDescriptor(window,'matchMedia');
    Object.defineProperty(window,'matchMedia',{configurable:true,value:(query:string)=>({matches:true,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn().mockReturnValue(true)})});
    TestBed.configureTestingModule({imports:[GameDiscovery],providers:[provideRouter([]),{provide:GameCatalogue,useValue:{load:vi.fn().mockResolvedValue(pool)}},{provide:QuickPlay,useValue:{playNow:play}}]});
  });
  afterEach(()=>{TestBed.resetTestingModule();if(mediaDescriptor)Object.defineProperty(window,'matchMedia',mediaDescriptor);else Reflect.deleteProperty(window,'matchMedia');});
  async function page(){const fixture=TestBed.createComponent(GameDiscovery);fixture.componentRef.setInput('gamePool',pool);fixture.componentRef.setInput('loadFromApi',false);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();return fixture;}
  it('always retains chess alongside two games and exposes only the visible action to keyboard focus',async()=>{
    const fixture=await page();const host:HTMLElement=fixture.nativeElement;
    expect(host.querySelectorAll('article')).toHaveLength(3);
    expect(host.querySelector('article a')?.getAttribute('href')).toBe('/chess');
    expect(host.querySelectorAll('article[aria-hidden="false"]')).toHaveLength(1);
    const next=host.querySelector<HTMLButtonElement>('[aria-label="Next featured game"]')!;next.click();fixture.detectChanges();
    expect(host.querySelector('article a')?.getAttribute('tabindex')).toBe('-1');
    expect(host.querySelectorAll('article[aria-hidden="false"]')).toHaveLength(1);
    expect(play).not.toHaveBeenCalled();
  });
  it('opens setup only after the visitor chooses a visible game',async()=>{
    const fixture=await page();const host:HTMLElement=fixture.nativeElement;
    host.querySelector<HTMLButtonElement>('[aria-label="Next featured game"]')!.click();fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('article[aria-hidden="false"] .btn')!.click();await fixture.whenStable();
    expect(play).toHaveBeenCalledOnce();expect(pool.some(g=>g.slug===play.mock.calls[0][0])).toBe(true);
  });
});
