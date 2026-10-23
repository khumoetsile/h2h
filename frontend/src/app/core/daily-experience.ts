import { inject, Injectable } from '@angular/core';
import { Api } from './api.service';
import { AuthService } from './auth.service';
import { DailyOverview } from './daily-predictions';
/** Share short-lived discovery reads. Submitted selections still use the original page/API. */
@Injectable({providedIn:'root'})
export class DailyExperience {
  private api = inject(Api);
  private auth = inject(AuthService);
  private cache = new Map<number,{data:DailyOverview;expires:number}>();
  private pending = new Map<number,Promise<DailyOverview>>();
  remember(data:DailyOverview) { this.cache.clear(); this.cache.set(this.auth.user?.()?.id ?? 0,{data,expires:Date.now()+15000}); }
  load(force=false): Promise<DailyOverview> {
    const key = this.auth.user?.()?.id ?? 0;
    const cached = this.cache.get(key);
    if (!force && cached && cached.expires > Date.now()) return Promise.resolve(cached.data);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.api.get<DailyOverview>('/daily-predictions').then(data => {
      if (!Array.isArray(data.challenges) || !data.stats) throw new Error('Prediction activity unavailable');
      this.cache.clear(); // Keep no earlier account's private selections in a long-lived discovery cache.
      this.cache.set(key,{data,expires:Date.now()+15000}); return data;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,request); return request;
  }
}
