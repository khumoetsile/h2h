import { TestBed } from '@angular/core/testing';
import { WordBattleGame } from './word-battle';
import { MemoryBattleGame } from './memory-battle';
import { ReactionRushGame } from './reaction-rush';
import { AimChallengeGame } from './aim-challenge';

describe('game controls and lifecycle',()=>{
  beforeEach(()=>vi.useFakeTimers());afterEach(()=>{TestBed.resetTestingModule();vi.useRealTimers();});
  it('word tiles support keyboard activation and focused Enter does not lock the whole word',()=>{
    TestBed.configureTestingModule({imports:[WordBattleGame]});const f=TestBed.createComponent(WordBattleGame);f.componentRef.setInput('spec',{words:[{scrambled:'CAT',length:3}],countdownMs:3000,limitMs:10000});f.detectChanges();const game=f.componentInstance as any;game.phase.set('input');game.order.set([0,1,2]);f.detectChanges();
    const button=f.nativeElement.querySelector('.lt') as HTMLButtonElement;button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));expect(game.picked()).toEqual([0]);
    const lock=vi.spyOn(game,'lockIn');game.onKey({key:'Enter',target:button,ctrlKey:false,altKey:false,metaKey:false});expect(lock).not.toHaveBeenCalled();
    const slot=f.nativeElement.querySelector('.slot') as HTMLButtonElement;f.detectChanges();slot.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));expect(game.picked()).toEqual([]);
  });
  it('memory numbered tiles support native keyboard clicks and one ended round cannot receive extra input',()=>{
    TestBed.configureTestingModule({imports:[MemoryBattleGame]});const f=TestBed.createComponent(MemoryBattleGame);f.componentRef.setInput('spec',{grid:2,rounds:[{sequence:[0]}],flashMs:100,gapMs:100,inputLimitMs:1000,countdownMs:3000});f.detectChanges();const game=f.componentInstance as any;game.phase.set('input');game.resolve=()=>{game.resolve=null;};f.detectChanges();const button=f.nativeElement.querySelector('.cell') as HTMLButtonElement;expect(button.textContent?.trim()).toBe('1');button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));expect(game.entered()).toEqual([0]);
  });
  it('reaction keyboard clicks record once and provisional impossible reactions earn zero',()=>{
    TestBed.configureTestingModule({imports:[ReactionRushGame]});const f=TestBed.createComponent(ReactionRushGame);f.componentRef.setInput('spec',{rounds:[{x:50,y:50,size:60,delayMs:100}],windowMs:1000,countdownMs:3000,interRoundMs:100});f.detectChanges();const game=f.componentInstance as any;game.phase.set('target');game.shownAt=performance.now()-150;const settle=vi.fn(()=>game.resolveRound=null);game.resolveRound=settle;f.detectChanges();const button=f.nativeElement.querySelector('.orb') as HTMLButtonElement;button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true}));expect(settle).toHaveBeenCalledOnce();game.results.set([{hit:true,reactionMs:50}]);expect(game.score()).toBe(0);
  });
  it('aim teardown settles a pending target and closes audio without emitting a result',()=>{
    TestBed.configureTestingModule({imports:[AimChallengeGame]});const f=TestBed.createComponent(AimChallengeGame);f.componentRef.setInput('spec',{targets:[{x:50,y:50,size:45}],lifetimeMs:1000,gapMs:100,countdownMs:3000});f.detectChanges();const game=f.componentInstance as any;const pending=vi.fn(),dispose=vi.spyOn(game.audio,'dispose'),finished=vi.fn();game.resolve=pending;game.finished.subscribe(finished);f.destroy();expect(pending).toHaveBeenCalledWith({hit:false});expect(dispose).toHaveBeenCalledOnce();expect(finished).not.toHaveBeenCalled();
  });
  it('keyboard aim fires at the chosen crosshair instead of automatically centering a target',()=>{
    TestBed.configureTestingModule({imports:[AimChallengeGame]});const f=TestBed.createComponent(AimChallengeGame);f.componentRef.setInput('spec',{targets:[{x:40,y:50,size:45}],lifetimeMs:1000,gapMs:100,countdownMs:3000});f.detectChanges();const game=f.componentInstance as any;game.phase.set('target');f.detectChanges();const arena=f.nativeElement.querySelector('.gx-arena'),target=f.nativeElement.querySelector('.t');vi.spyOn(arena,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:300,height:200});vi.spyOn(target,'getBoundingClientRect').mockReturnValue({left:100,top:80,width:40,height:40});game.resolve=vi.fn();game.keyAim({key:'Enter',repeat:false,preventDefault:()=>{}});expect(game.resolve).toHaveBeenCalledWith({hit:false});
  });
});
