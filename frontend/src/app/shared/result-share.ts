import { Component, computed, input, signal } from '@angular/core';
/** Share only a verified result summary and the public home URL, never a private match URL. */
@Component({selector:'app-result-share',template:`<div class="sharing"><button class="btn" (click)="share()">Share result</button><button class="btn btn-ghost" (click)="copy()">Copy result</button>@if(message()){<p role="status">{{message()}}</p>}</div>`,styles:[`.sharing{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.sharing p{flex-basis:100%;font-size:14px;color:var(--text-2)}`]})
export class ResultShare {
  readonly game=input.required<string>();readonly result=input.required<string>();
  protected message=signal('');
  private text=computed(()=>`${this.game()} on Head2Head: ${this.result()}. Demo competition. ${location.origin}/`);
  protected async share(){if(!navigator.share){await this.copy();return;}try{await navigator.share({title:'My Head2Head result',text:this.text()});}catch(e){if((e as Error).name!=='AbortError')this.message.set('Sharing is unavailable. Use Copy result.');}}
  protected async copy(){try{await navigator.clipboard.writeText(this.text());this.message.set('Result copied.');}catch{this.message.set(this.text());}}
}
