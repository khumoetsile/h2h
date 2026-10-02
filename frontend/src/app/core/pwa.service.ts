import { computed, inject, Injectable, signal } from '@angular/core';
import { Api } from './api.service';

/** The event Chrome and Android browsers fire when the site can be installed. Not in TypeScript's DOM types. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type PushState = 'unsupported' | 'unavailable' | 'needs-install' | 'blocked' | 'off' | 'on';

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/**
 * Everything about living on a phone's home screen: the install button, and notifications.
 * Both are optional extras; if the browser lacks something the matching signal says so and the UI hides itself.
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private api = inject(Api);
  private deferred: InstallPromptEvent | null = null;

  private ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  readonly isIos = /iPhone|iPad|iPod/.test(this.ua) || (/Macintosh/.test(this.ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  readonly installed = signal(this.isStandalone());
  private promptReady = signal(false);
  /** Android/Chrome can show its own install dialog; iPhones need the "Add to Home Screen" steps instead. */
  readonly canInstall = computed(() => !this.installed() && this.promptReady());
  readonly needsIosSteps = computed(() => !this.installed() && this.isIos);

  readonly pushState = signal<PushState>('unsupported');
  private publicKey: string | null = null;

  /** Call once at startup. */
  init() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferred = e as InstallPromptEvent;
      this.promptReady.set(true);
    });
    window.addEventListener('appinstalled', () => { this.installed.set(true); this.promptReady.set(false); });
    if ('serviceWorker' in navigator) {
      // Register once the page has settled, so it never competes with the first screen.
      const go = () => navigator.serviceWorker.register('/sw.js').catch(() => { /* private mode etc. */ });
      if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
    }
  }

  private isStandalone() {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  }

  async install() {
    if (!this.deferred) return;
    await this.deferred.prompt();
    const { outcome } = await this.deferred.userChoice;
    this.deferred = null;
    this.promptReady.set(false);
    if (outcome === 'accepted') this.installed.set(true);
  }

  /** Work out what notifications can do here. Safe to call whenever a screen that offers them opens. */
  async refreshPush() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      // iPhones only allow notifications for apps added to the home screen.
      this.pushState.set(this.isIos && !this.installed() ? 'needs-install' : 'unsupported');
      return;
    }
    try {
      if (this.publicKey === null) this.publicKey = (await this.api.get<{ publicKey: string | null }>('/push/key')).publicKey ?? '';
    } catch { this.publicKey = ''; }
    if (!this.publicKey) { this.pushState.set('unavailable'); return; }
    if (Notification.permission === 'denied') { this.pushState.set('blocked'); return; }
    const reg = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => undefined);
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    this.pushState.set(sub && Notification.permission === 'granted' ? 'on' : 'off');
  }

  /** Ask permission (must be called from a tap), subscribe, and tell the server. Returns true when notifications are on. */
  async enablePush(): Promise<boolean> {
    await this.refreshPush();
    if (this.pushState() === 'on') return true;
    if (this.pushState() !== 'off' || !this.publicKey) return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { this.pushState.set(permission === 'denied' ? 'blocked' : 'off'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(this.publicKey) });
    await this.api.post('/push/subscribe', sub.toJSON());
    this.pushState.set('on');
    return true;
  }

  async disablePush() {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await this.api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe();
    }
    this.pushState.set('off');
  }
}
