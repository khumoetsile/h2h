import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Api } from './api.service';
import { AuthService } from './auth.service';

export type Surface = 'home'|'games'|'football'|'analysis'|'predictions'|'arena'|'challenges'|'matches'|'rankings'|'profile';
export function measurementSurface(url:string):Surface|null {
  const path = url.split(/[?#]/)[0];
  if (path === '/dashboard') return 'home';
  if (/^\/football\/(research|\d+|teams)/.test(path)) return 'analysis';
  if (path === '/football') return 'football';
  if (path.startsWith('/games')) return 'games';
  if (path.startsWith('/daily-predictions')) return 'predictions';
  if (path.startsWith('/arena')) return 'arena';
  if (path.startsWith('/challenges')) return 'challenges';
  if (/^\/(matches|match|chess)(\/|$)/.test(path)) return 'matches';
  if (path === '/leaderboard') return 'rankings';
  return path === '/profile' ? 'profile' : null;
}
/** Explicit opt-in. Send categories, never raw URLs, query strings, account inputs or wallet data. */
@Injectable({providedIn:'root'})
export class ExperienceMeasurement {
  private auth = inject(AuthService);
  private api = inject(Api);
  private router = inject(Router);
  private destroy = inject(DestroyRef);
  private revision = signal(0);
  private key = computed(()=>`h2h.measurement.${this.auth.user()?.id ?? 'guest'}`);
  private visits = new Map<number,string>();
  private disabled = signal(false);
  private pending = new Set<Promise<unknown>>();
  readonly enabled = computed(()=>{this.revision();try{return !this.disabled() && !!this.auth.user() && localStorage.getItem(this.key())==='yes';}catch{return false;}});
  constructor() {
    this.router.events.pipe(filter(e=>e instanceof NavigationEnd),takeUntilDestroyed(this.destroy)).subscribe(e=>{
      const surface=measurementSurface((e as NavigationEnd).urlAfterRedirects);
      if(surface) this.record('page_view',surface);
    });
  }
  enable(enabled:boolean) {
    this.disabled.set(!enabled);
    try { localStorage.setItem(this.key(),enabled?'yes':'no');this.revision.update(n=>n+1);return true; }catch{return false;}
  }
  record(event:'page_view'|'primary_action'|'empty_recovery'|'onboarding_saved',surface:Surface) {
    const uid=this.auth.user()?.id;
    if(!uid || !this.enabled()) return;
    let visit=this.visits.get(uid);
    if(!visit){visit=crypto.randomUUID();this.visits.set(uid,visit);}
    const request=this.api.post('/experience/events',{eventId:crypto.randomUUID(),visitId:visit,event,surface}).catch(()=>{});
    this.pending.add(request); void request.finally(()=>this.pending.delete(request));
  }
  async erase() { this.enable(false); await Promise.allSettled([...this.pending]); await this.api.delete('/experience/events'); }
}
