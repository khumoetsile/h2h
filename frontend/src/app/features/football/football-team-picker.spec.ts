import { TestBed } from '@angular/core/testing';
import { FootballResearchStore } from '../../core/football-research';
import { FootballTeamPicker } from './football-team-picker';

const liverpool={id:1,name:'Liverpool FC',shortName:'Liverpool',crestUrl:null};
const chelsea={id:2,name:'Chelsea FC',shortName:'Chelsea',crestUrl:null};
describe('football team search',()=>{
  it('ignores a slow earlier search and lets keyboard users select a current result',async()=>{
    let oldResolve!:(value:unknown)=>void,newResolve!:(value:unknown)=>void;
    const teams=vi.fn().mockReturnValueOnce(new Promise(done=>oldResolve=done)).mockReturnValueOnce(new Promise(done=>newResolve=done));
    TestBed.configureTestingModule({imports:[FootballTeamPicker],providers:[{provide:FootballResearchStore,useValue:{teams}}]});
    const fixture=TestBed.createComponent(FootballTeamPicker);fixture.componentRef.setInput('id','team-test');fixture.componentRef.setInput('label','Team');fixture.detectChanges();
    const component=fixture.componentInstance as any;const selection=vi.fn();fixture.componentInstance.selectedChange.subscribe(selection);
    component.expanded.set(true);const older=component.load('Liverpool'),newer=component.load('Chelsea');newResolve({teams:[chelsea]});await newer;oldResolve({teams:[liverpool]});await older;
    expect(component.options()).toEqual([chelsea]);
    component.keyboard(new KeyboardEvent('keydown',{key:'ArrowDown'}));component.keyboard(new KeyboardEvent('keydown',{key:'Enter'}));
    expect(selection).toHaveBeenCalledWith(chelsea);expect(component.expanded()).toBe(false);
  });
  it('separates search failure from a genuine empty sample and permits retry',async()=>{
    const teams=vi.fn().mockRejectedValueOnce(new Error('No network')).mockResolvedValue({teams:[]});
    TestBed.configureTestingModule({imports:[FootballTeamPicker],providers:[{provide:FootballResearchStore,useValue:{teams}}]});
    const fixture=TestBed.createComponent(FootballTeamPicker);fixture.componentRef.setInput('id','team-test');fixture.componentRef.setInput('label','Team');fixture.detectChanges();
    const component=fixture.componentInstance as any;component.expanded.set(true);await component.load('Chelsea');fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Try again');await component.load('Chelsea',true);fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No matching teams');expect(fixture.nativeElement.textContent).not.toContain('Try again');
  });
  it('labels the actual input even when the component host has an id and opens ArrowUp at the last option',async()=>{
    const teams=vi.fn().mockResolvedValue({teams:[liverpool,chelsea]});
    TestBed.configureTestingModule({imports:[FootballTeamPicker],providers:[{provide:FootballResearchStore,useValue:{teams}}]});
    const fixture=TestBed.createComponent(FootballTeamPicker);fixture.nativeElement.id='team-test';fixture.componentRef.setInput('id','team-test');fixture.componentRef.setInput('label','First team');fixture.detectChanges();
    const input=fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.id).toBe('team-test-input');expect(input.labels?.[0].textContent).toBe('First team');
    const component=fixture.componentInstance as any;await component.load('');component.expanded.set(true);component.keyboard(new KeyboardEvent('keydown',{key:'ArrowUp'}));
    expect(component.index()).toBe(1);
  });
});
