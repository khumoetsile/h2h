import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Subject, debounceTime } from 'rxjs';
import { Api } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Paged, User } from '../../core/models';
import { Toast } from '../../core/toast.service';
import { MoneyPipe } from '../../shared/pipes';
import { Avatar, EmptyState, LoadError, SkeletonList } from '../../shared/ui';

type AdminUser = User & { wallet: { available: number; locked: number }; played: number };

@Component({
  selector: 'app-admin-users',
  imports: [FormsModule, DatePipe, MatIconModule, MoneyPipe, Avatar, EmptyState, LoadError, SkeletonList],
  template: `
    <div class="page">
      <div class="page-head"><div><h1>Users</h1><p class="sub">{{ data()?.total ?? 0 }} accounts</p></div></div>
      <div class="filters">
        <div class="search"><mat-icon>search</mat-icon><input [(ngModel)]="q" (ngModelChange)="search$.next($event)" placeholder="Search username, name, email or phone" /></div>
        <div class="segmented">
          <button [class.active]="status() === ''" (click)="setStatus('')">All</button>
          <button [class.active]="status() === 'ACTIVE'" (click)="setStatus('ACTIVE')">Enabled</button>
          <button [class.active]="status() === 'DISABLED'" (click)="setStatus('DISABLED')">Disabled</button>
        </div>
        <label class="small muted bots"><input type="checkbox" [(ngModel)]="includeBots" (change)="go(1)" /> Include demo bots</label>
      </div>
      <div class="card card-flush">
        @if (error()) { <app-load-error [message]="error()" (retry)="go(1)" /> }
        @else if (!data()) { <app-skeleton-list [rows]="8" /> }
        @else if (data()!.items.length === 0) { <app-empty icon="person_search" title="No players found" text="Try a different search." /> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th class="right">Available</th><th class="right">Locked</th><th class="right">Played</th><th>Joined</th><th></th></tr></thead>
              <tbody>
                @for (u of data()!.items; track u.id) {
                  <tr class="clickable" (click)="open(u)">
                    <td><div class="row"><app-avatar [name]="u.username" [color]="u.avatarColor" [size]="28" /><div><strong>{{ u.username }}</strong><div class="muted tiny">{{ u.firstName }} {{ u.lastName }}</div></div>
                      @if (u.isDemoData) { <span class="chip chip-demo">demo</span> } @if (u.isBot) { <span class="chip">bot</span> }</div></td>
                    <td class="muted">{{ u.email }}</td>
                    <td><span class="chip" [class.chip-info]="u.role === 'ADMIN'">{{ u.role }}</span></td>
                    <td><span class="chip" [class.chip-win]="u.status === 'ACTIVE'" [class.chip-loss]="u.status === 'DISABLED'">{{ u.status }}</span></td>
                    <td class="right money">{{ u.wallet.available | money }}</td>
                    <td class="right money">{{ u.wallet.locked | money }}</td>
                    <td class="right num">{{ u.played }}</td>
                    <td class="muted">{{ u.createdAt | date: 'd MMM y' }}</td>
                    <td class="right" (click)="$event.stopPropagation()">
                      @if (u.id !== auth.user()?.id) {
                        <button class="btn btn-sm" [class.btn-danger]="u.status === 'ACTIVE'" [disabled]="busy() === u.id" (click)="toggle(u)">{{ u.status === 'ACTIVE' ? 'Disable' : 'Enable' }}</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pager">
            <button class="btn btn-sm" [disabled]="data()!.page <= 1" (click)="go(data()!.page - 1)">Prev</button>
            <span class="muted small">Page {{ data()!.page }} of {{ pages() }}</span>
            <button class="btn btn-sm" [disabled]="data()!.page >= pages()" (click)="go(data()!.page + 1)">Next</button>
          </div>
        }
      </div>
    </div>
  `,
  styleUrl: './admin-common.scss',
})
export class AdminUsersPage implements OnInit {
  private api = inject(Api);
  protected auth = inject(AuthService);
  private toast = inject(Toast);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  protected data = signal<Paged<AdminUser> | null>(null);
  protected error = signal('');
  protected status = signal<'' | 'ACTIVE' | 'DISABLED'>('');
  protected busy = signal<number | null>(null);
  protected q = '';
  protected includeBots = false;
  protected search$ = new Subject<string>();

  ngOnInit() {
    this.go(1);
    this.search$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.go(1));
  }
  pages() { const d = this.data(); return d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1; }
  setStatus(s: '' | 'ACTIVE' | 'DISABLED') { this.status.set(s); this.go(1); }
  open(u: AdminUser) { this.router.navigate(['/admin/users', u.id]); }

  async go(page: number) {
    this.error.set('');
    try {
      this.data.set(await this.api.get<Paged<AdminUser>>('/admin/users', { q: this.q, status: this.status(), includeBots: this.includeBots || null, page, pageSize: 20 }));
    } catch { this.error.set('Could not load users.'); }
  }

  async toggle(u: AdminUser) {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (next === 'DISABLED' && !confirm(`Disable @${u.username}? They will be signed out immediately.`)) return;
    this.busy.set(u.id);
    try {
      await this.api.post(`/admin/users/${u.id}/status`, { status: next });
      this.toast.success(`@${u.username} ${next === 'DISABLED' ? 'disabled' : 'enabled'}.`);
      this.data.update((d) => d && { ...d, items: d.items.map((x) => (x.id === u.id ? { ...x, status: next } : x)) });
    } catch (err) { this.toast.error(err); } finally { this.busy.set(null); }
  }
}
