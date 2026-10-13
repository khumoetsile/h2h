import { Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { apiError } from '../../core/api-error';
import { FootballResearchStore, ResearchTeam } from '../../core/football-research';

@Component({
  selector:'app-football-team-picker',imports:[FormsModule],
  template:`
    <div class="picker">
      <label [for]="id()+'-input'">{{ label() }}</label>
      <div class="input-wrap">@if(selected()?.crestUrl){<img [src]="selected()!.crestUrl!" alt="" width="24" height="24" loading="lazy"/>}<input [id]="id()+'-input'" [ngModel]="query()" (ngModelChange)="search($event)" (focus)="open()" (blur)="blur()" (keydown)="keyboard($event)" role="combobox" aria-autocomplete="list" [attr.aria-expanded]="expanded()" [attr.aria-controls]="id()+'-options'" [attr.aria-activedescendant]="expanded()&&index()>=0?id()+'-option-'+index():null" autocomplete="off" placeholder="Search teams…"/><span class="arrow" aria-hidden="true">⌄</span></div>
      @if(expanded()) {
        <div class="options" [id]="id()+'-options'" role="listbox" [attr.aria-label]="label()+' results'">
          @if(loading()){<div class="picker-status" role="status">Finding teams…</div>}
          @else if(error()){<div class="picker-status" role="status">{{error()}}<button class="retry" type="button" (mousedown)="$event.preventDefault()" (click)="load(query(),true)">Try again</button></div>}
          @else if(!options().length){<div class="picker-status" role="status">No matching teams in available data.</div>}
          @else {@for(team of options();track team.id;let i=$index){<button class="option" type="button" role="option" tabindex="-1" [id]="id()+'-option-'+i" [class.active]="index()===i" [attr.aria-selected]="selected()?.id===team.id" (mousedown)="$event.preventDefault()" (click)="pick(team)">@if(team.crestUrl){<img [src]="team.crestUrl" alt="" width="24" height="24" loading="lazy"/>}<span>{{team.name}}</span>@if(selected()?.id===team.id){<span aria-hidden="true">✓</span>}</button>}}
        </div>
      }
    </div>
  `,
  styles:[`
    :host{display:block;min-width:0}.picker{position:relative}label{display:block;color:var(--text-2);font-size:12px;font-weight:600;margin-bottom:7px}.input-wrap{display:flex;align-items:center;gap:9px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-elev);padding:0 13px}.input-wrap:focus-within{outline:2px solid var(--accent);outline-offset:2px}input{width:100%;min-width:0;min-height:52px;border:0;background:transparent;color:var(--text);font:inherit;outline:none!important}.arrow{color:var(--muted)}img{object-fit:contain;flex-shrink:0}.options{position:absolute;top:100%;margin-top:7px;left:0;right:0;z-index:15;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 14px 30px #0007;max-height:280px;overflow:auto}.option{display:flex;align-items:center;gap:10px;width:100%;padding:10px 13px;min-height:48px;text-align:left;color:var(--text);font-size:14px;background:transparent}.option span:first-of-type{flex:1;overflow-wrap:anywhere}.option.active,.option:hover{background:var(--surface-3)}.picker-status{padding:16px;color:var(--text-2);font-size:13px}.retry{display:block;min-height:44px;margin-top:8px;text-decoration:underline;color:var(--accent)}
  `],
})
export class FootballTeamPicker {
  readonly id=input.required<string>();readonly label=input.required<string>();readonly selected=input<ResearchTeam|null>(null);readonly exclude=input<number|null>(null);readonly selectedChange=output<ResearchTeam>();
  private store=inject(FootballResearchStore);private destroy=inject(DestroyRef);private changes=new Subject<{q:string;version:number}>();private version=0;
  protected query=signal('');protected expanded=signal(false);protected loading=signal(false);protected error=signal('');protected index=signal(-1);private teams=signal<ResearchTeam[]>([]);
  protected options=computed(()=>this.teams().filter(team=>team.id!==this.exclude()));
  constructor(){effect(()=>{this.query.set(this.selected()?.name??'');});this.changes.pipe(debounceTime(200),takeUntilDestroyed(this.destroy)).subscribe(({q,version})=>void this.load(q,false,version));}
  protected open(){this.expanded.set(true);this.index.set(-1);void this.load(this.selected()?.name===this.query()?'':this.query());}
  search(q:string){this.query.set(q);this.expanded.set(true);this.teams.set([]);this.loading.set(true);this.error.set('');this.index.set(-1);this.changes.next({q,version:++this.version});}
  async load(q:string,force=false,version=++this.version){
    if(version!==this.version)return;this.loading.set(true);this.error.set('');
    try{const result=await this.store.teams(q,force);if(version===this.version)this.teams.set(result.teams);}
    catch(err){if(version===this.version){this.error.set(apiError(err).message);this.teams.set([]);}}
    finally{if(version===this.version)this.loading.set(false);}
  }
  protected pick(team:ResearchTeam){++this.version;this.query.set(team.name);this.expanded.set(false);this.loading.set(false);this.selectedChange.emit(team);}
  protected blur(){setTimeout(()=>this.expanded.set(false),120);}
  protected keyboard(event:KeyboardEvent){
    if(event.key==='Escape'){event.preventDefault();this.expanded.set(false);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!this.expanded())this.open();const count=this.options().length;if(count)this.index.set(this.index()<0?(event.key==='ArrowDown'?0:count-1):(this.index()+(event.key==='ArrowDown'?1:-1)+count)%count);return;}
    if(event.key==='Enter'&&this.expanded()){event.preventDefault();const team=this.options()[this.index()];if(team)this.pick(team);}
  }
}
