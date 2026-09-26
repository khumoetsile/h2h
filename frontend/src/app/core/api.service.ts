import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

type Params = Record<string, string | number | boolean | null | undefined>;

/** Small promise-based wrapper around HttpClient for the /api backend. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private base = '/api';

  private params(p?: Params) {
    let hp = new HttpParams();
    for (const [k, v] of Object.entries(p || {})) if (v !== null && v !== undefined && v !== '') hp = hp.set(k, String(v));
    return hp;
  }

  get<T>(path: string, params?: Params) { return firstValueFrom(this.http.get<T>(this.base + path, { params: this.params(params) })); }
  post<T>(path: string, body: unknown = {}) { return firstValueFrom(this.http.post<T>(this.base + path, body)); }
  put<T>(path: string, body: unknown = {}) { return firstValueFrom(this.http.put<T>(this.base + path, body)); }
  patch<T>(path: string, body: unknown = {}) { return firstValueFrom(this.http.patch<T>(this.base + path, body)); }
}
