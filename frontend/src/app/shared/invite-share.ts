import { Component, computed, inject, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Toast } from '../core/toast.service';

/** "Send this to a friend": WhatsApp first (it is how people here share), then the phone's own share sheet, then copy. */
@Component({
  selector: 'app-invite-share',
  imports: [MatIconModule],
  template: `
    <div class="box">
      <p><strong>Challenge code: {{ code() }}</strong></p>
      <button class="btn" type="button" (click)="copyCode()">Copy code</button>
      <p class="lead">Send this link to a friend. They can join as a guest, review the entry and get ready to play you.</p>
      <a class="btn btn-primary btn-play btn-block" [href]="whatsapp()" target="_blank" rel="noopener">
        <mat-icon>send</mat-icon> Send on WhatsApp
      </a>
      <div class="row">
        @if (canShare) { <button class="btn" type="button" (click)="share()"><mat-icon>share</mat-icon> Share</button> }
        <button class="btn" type="button" (click)="copy()">
          <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon> {{ copied() ? 'Copied' : 'Copy link' }}
        </button>
      </div>
      <p class="url muted tiny">{{ link() }}</p>
    </div>
  `,
  styles: [`
    .box { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .lead { color: var(--text-2); font-size: 17px; line-height: 1.4; }
    .row { display: flex; gap: 8px; }
    .row .btn { flex: 1; }
    .url { word-break: break-all; text-align: center; }
  `],
})
export class InviteShare {
  private toast = inject(Toast);
  readonly code = input.required<string>();
  readonly game = input.required<string>();

  protected copied = signal(false);
  protected canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  protected link = computed(() => `${location.origin}/join/${this.code()}`);
  private text = computed(() => `I challenge you to ${this.game()} on Head2Head. Demo funds only. Enter code ${this.code()} or tap to review:`);
  protected whatsapp = computed(() => `https://wa.me/?text=${encodeURIComponent(`${this.text()} ${this.link()}`)}`);

  protected async share() {
    try { await navigator.share({ title: 'Head2Head challenge', text: this.text(), url: this.link() }); } catch { /* closed the sheet */ }
  }

  protected async copyCode() {
    try { await navigator.clipboard.writeText(this.code()); this.toast.info('Challenge code copied.'); }
    catch { this.toast.info('Challenge code: ' + this.code()); }
  }
  protected async copy() {
    try {
      await navigator.clipboard.writeText(this.link());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch { this.toast.info(`Copy this link: ${this.link()}`); }
  }
}
