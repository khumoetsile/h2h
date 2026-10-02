import { Component, ElementRef, OnDestroy, input, output, signal, viewChild } from '@angular/core';
import { ShootoutAudio } from './shootout-audio';
import { KickOutcome, KickQuality, zoneCol, zoneIsHigh } from './shootout.model';

/** What the scene needs to replay one resolved kick. */
export interface KickReplay {
  zone: number | null;
  keeperZone: number;
  outcome: KickOutcome;
  quality: KickQuality;
  /** True when the viewer took this kick (colours the kit, picks the cheer or the groan). */
  meKicker: boolean;
}

// Scene geometry (SVG user units, viewBox 0 0 360 400).
const GOAL_X0 = 70;
const COL_W = 220 / 3;
const SPOT = { x: 180, y: 276 };
const colX = (c: number) => GOAL_X0 + COL_W * (c + 0.5);
const zoneY = (high: boolean) => (high ? 141 : 174);

const ME = { jersey: '#f5701f', sock: '#c9560f' };
const OPP = { jersey: '#6fa8dc', sock: '#4f86b8' };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The shootout stage: a stadium drawn in plain SVG (no images, canvas or
 * libraries), animated with the Web Animations API so every move runs on the
 * compositor. It is dumb on purpose: it draws what it is told (a target
 * selection, a resolved kick) and never decides anything.
 */
@Component({
  selector: 'app-shootout-scene',
  template: `
    <div class="cam" #cam>
      <svg viewBox="0 0 360 400" preserveAspectRatio="xMidYMax slice" role="img" aria-label="Penalty shootout pitch">
        <defs>
          <pattern id="so-net" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 0H7M0 0V7" stroke="#fff" stroke-opacity=".34" stroke-width=".7" fill="none"/></pattern>
          <pattern id="so-crowd" width="40" height="14" patternUnits="userSpaceOnUse">
            <circle cx="5" cy="5" r="3.3" fill="#2f3b34"/><circle cx="14" cy="9" r="3.3" fill="#3f4c43"/><circle cx="23" cy="5" r="3.3" fill="#4b3f35"/>
            <circle cx="32" cy="9" r="3.3" fill="#34413a"/><circle cx="38" cy="4" r="2.6" fill="#f5701f" fill-opacity=".75"/><circle cx="19" cy="12" r="2.4" fill="#6fa8dc" fill-opacity=".55"/>
          </pattern>
        </defs>

        <!-- stands, crowd and advertising boards -->
        <rect width="360" height="76" fill="#0c110e"/>
        <g #crowd><rect y="6" width="360" height="66" fill="url(#so-crowd)"/><rect y="20" width="360" height="1.5" fill="#0c110e" fill-opacity=".6"/><rect y="38" width="360" height="1.5" fill="#0c110e" fill-opacity=".6"/><rect y="56" width="360" height="1.5" fill="#0c110e" fill-opacity=".6"/></g>
        <rect y="76" width="360" height="20" fill="#16201a"/>
        <g font-family="var(--font-display)" font-weight="700" font-size="12" text-anchor="middle">
          <rect x="0" y="78" width="90" height="16" fill="#f5701f"/><text x="45" y="90.5" fill="#14100c">HEAD2HEAD</text>
          <rect x="90" y="78" width="90" height="16" fill="#eceae3"/><text x="135" y="90.5" fill="#14100c">HEAD2HEAD</text>
          <rect x="180" y="78" width="90" height="16" fill="#f5701f"/><text x="225" y="90.5" fill="#14100c">HEAD2HEAD</text>
          <rect x="270" y="78" width="90" height="16" fill="#eceae3"/><text x="315" y="90.5" fill="#14100c">HEAD2HEAD</text>
        </g>

        <!-- mown pitch, in perspective -->
        <rect y="96" width="360" height="304" fill="#2c4b37"/>
        <g fill="#34593f">
          <rect y="112" width="360" height="14"/><rect y="142" width="360" height="20"/><rect y="186" width="360" height="28"/>
          <rect y="248" width="360" height="42"/><rect y="340" width="360" height="60"/>
        </g>
        <g fill="none" stroke="#eceae3" stroke-opacity=".9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M0 190H360" stroke-width="2"/>
          <path d="M112 190L100 214H260L248 190" stroke-width="1.8"/>
          <path d="M34 190L-8 338H368L326 190" stroke-width="2"/>
          <path d="M120 338Q180 374 240 338" stroke-width="2"/>
        </g>
        <ellipse cx="180" cy="278" rx="3.4" ry="2" fill="#eceae3"/>

        <!-- goal: back net, side and roof nets -->
        <g #netBack>
          <rect x="88" y="130" width="184" height="54" fill="#0a0f0c" fill-opacity=".55"/>
          <rect x="88" y="130" width="184" height="54" fill="url(#so-net)"/>
          <polygon points="70,124 88,130 88,184 70,190" fill="url(#so-net)" fill-opacity=".8"/>
          <polygon points="290,124 272,130 272,184 290,190" fill="url(#so-net)" fill-opacity=".8"/>
          <polygon points="70,124 290,124 272,130 88,130" fill="url(#so-net)" fill-opacity=".9"/>
          <g stroke="#eceae3" stroke-opacity=".7" stroke-width="1.4" fill="none"><path d="M88 130V184"/><path d="M272 130V184"/><path d="M88 130H272"/></g>
        </g>

        <!-- goalkeeper -->
        <g transform="translate(180 190) scale(0.92)">
          <ellipse #kShadow cx="0" cy="1" rx="15" ry="3.2" fill="#000" fill-opacity=".3"/>
          <g class="k-lean" [style.transform]="lean()">
          <g #keeper class="k-body">
            <g class="k-sway">
              <rect x="-8.5" y="-17" width="6.5" height="17" rx="2" [attr.fill]="keeperKit().sock"/>
              <rect x="2" y="-17" width="6.5" height="17" rx="2" [attr.fill]="keeperKit().sock"/>
              <rect x="-9.5" y="-3.2" width="8" height="3.4" rx="1.6" fill="#14100c"/><rect x="1.5" y="-3.2" width="8" height="3.4" rx="1.6" fill="#14100c"/>
              <rect x="-10.5" y="-27" width="21" height="11" rx="3" fill="#14100c"/>
              <g #armL class="arm"><rect x="-18" y="-45" width="6.5" height="20" rx="3.2" [attr.fill]="keeperKit().jersey"/><circle cx="-14.7" cy="-24" r="4.4" fill="#fff"/></g>
              <g #armR class="arm"><rect x="11.5" y="-45" width="6.5" height="20" rx="3.2" [attr.fill]="keeperKit().jersey"/><circle cx="14.7" cy="-24" r="4.4" fill="#fff"/></g>
              <rect x="-11.5" y="-47" width="23" height="22" rx="6" [attr.fill]="keeperKit().jersey"/>
              <circle cx="0" cy="-54.5" r="6.6" fill="#c9a27a"/>
              <path d="M-6.8 -55.5a6.8 6.8 0 0 1 13.6 0z" fill="#2a2018"/>
            </g>
          </g>
          </g>
        </g>

        <!-- goal frame, in front of the keeper -->
        <rect x="67.5" y="121.5" width="225" height="5" rx="2.5" fill="#eceae3"/>
        <rect x="67.5" y="122" width="5" height="70" rx="2.5" fill="#eceae3"/>
        <rect x="287.5" y="122" width="5" height="70" rx="2.5" fill="#eceae3"/>
        <rect x="72.5" y="126.5" width="215" height="63.5" fill="url(#so-net)" fill-opacity=".35"/>
        <circle #ripple cx="180" cy="160" r="4" fill="none" stroke="#fff" stroke-width="1.6" opacity="0"/>

        <!-- the kicker, seen from behind -->
        <g transform="translate(180 399) scale(1.22)">
          <g #kicker class="kk-run">
            <ellipse cx="0" cy="1" rx="17" ry="3.6" fill="#000" fill-opacity=".3"/>
            <g class="kk-sway">
              <rect x="-8.5" y="-19" width="6.5" height="19" rx="2" [attr.fill]="kickerKit().sock"/>
              <rect x="-9.5" y="-3.2" width="8" height="3.4" rx="1.6" fill="#14100c"/>
              <g #kickLeg class="kick-leg"><rect x="2" y="-19" width="6.5" height="19" rx="2" [attr.fill]="kickerKit().sock"/><rect x="1.5" y="-3.2" width="8" height="3.4" rx="1.6" fill="#14100c"/></g>
              <rect x="-11" y="-29" width="22" height="12" rx="3" fill="#14100c"/>
              <rect x="-18.5" y="-50" width="5.8" height="20" rx="2.9" [attr.fill]="kickerKit().jersey"/>
              <rect x="12.7" y="-50" width="5.8" height="20" rx="2.9" [attr.fill]="kickerKit().jersey"/>
              <rect x="-12.5" y="-52" width="25" height="24" rx="7" [attr.fill]="kickerKit().jersey"/>
              <text x="0" y="-34" font-family="var(--font-display)" font-weight="700" font-size="13" text-anchor="middle" fill="#14100c" fill-opacity=".85">10</text>
              <rect x="-2.6" y="-57" width="5.2" height="6" fill="#c9a27a"/>
              <circle cx="0" cy="-60.5" r="7" fill="#2a2018"/>
            </g>
          </g>
        </g>

        <path #trail d="M180 276L180 276" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-opacity=".75" opacity="0"/>
        <!-- ball on the spot -->
        <ellipse #shadow cx="180" cy="288" rx="9" ry="3" fill="#000" fill-opacity=".28"/>
        <g #ball class="ball">
          <circle cx="180" cy="276" r="11" fill="#fff" stroke="#14100c" stroke-width="1.4"/>
          <path d="M180 271.4l4.4 3.2-1.7 5.2h-5.4l-1.7-5.2z" fill="#14100c"/>
          <path d="M180 271.4V266M184.4 274.6l5-1.6M182.7 279.8l3 4.2M177.3 279.8l-3 4.2M175.6 274.6l-5-1.6" stroke="#14100c" stroke-width="1.2" fill="none" stroke-linecap="round"/>
        </g>

        <!-- what the player can tap -->
        @if (mode() === 'KICKER') {
          @for (z of zones; track z) {
            <g class="zone" [class.live]="interactive()" [class.sel]="aimZone() === z" (pointerdown)="onZone($event, z)">
              <rect [attr.x]="70 + (z % 3) * 73.33" [attr.y]="z < 3 ? 112 : 157" width="73.33" [attr.height]="z < 3 ? 45 : 41" fill="transparent"/>
              <circle class="ring" [attr.cx]="colCentre(z % 3)" [attr.cy]="z < 3 ? 141 : 174" r="12"/>
              <g class="reticle" [attr.transform]="'translate(' + colCentre(z % 3) + ' ' + (z < 3 ? 141 : 174) + ')'"><circle r="6.5"/><path d="M0 -14V-9M0 14V9M-14 0H-9M14 0H9"/></g>
            </g>
          }
        } @else if (mode() === 'KEEPER') {
          @for (z of zones; track z) {
            <g class="col" [class.live]="interactive()" [class.sel]="diveZone() === z" (pointerdown)="onDive($event, z)">
              <rect [attr.x]="70 + (z % 3) * 73.33" [attr.y]="z < 3 ? 112 : 157" width="73.33" [attr.height]="z < 3 ? 45 : 41" fill="transparent"/>
              <rect class="band" [attr.x]="70 + (z % 3) * 73.33 + 3" [attr.y]="z < 3 ? 116 : 160" width="67.33" [attr.height]="z < 3 ? 37 : 34" rx="4"/>
              <path class="chev" [attr.d]="diveChev(z)"/>
            </g>
          }
        }
      </svg>

      <div class="confetti" [class.on]="confetti()" aria-hidden="true">
        @for (p of pieces; track $index) { <i [style.--x.%]="p.x" [style.--d.ms]="p.d" [style.--r.deg]="p.r" [style.--drift.px]="p.drift" [style.background]="p.c"></i> }
      </div>
    </div>

    @if (caption(); as c) { <div class="role-cap">{{ c }}</div> }
    @if (countdown() !== null) { <div class="count" aria-hidden="true">{{ countdown() }}</div> }
    @if (banner(); as b) { <div class="banner" [attr.data-k]="b.kind" [attr.data-t]="b.tone"><strong>{{ b.title }}</strong><span>{{ b.sub }}</span></div> }
  `,
  styles: [`
    :host { position: relative; display: block; width: 100%; aspect-ratio: 360 / 400; max-height: 50vh; overflow: hidden; border-radius: var(--radius); background: #0c110e; contain: layout paint; }
    @media (orientation: landscape) and (max-height: 540px) { :host { max-height: none; height: 100%; aspect-ratio: auto; } }
    .cam { position: absolute; inset: 0; transform-origin: 50% 38%; will-change: transform; }
    svg { display: block; width: 100%; height: 100%; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
    .k-body, .kk-run, .kick-leg, .arm, .ball { transform-box: fill-box; will-change: transform; }
    .k-body { transform-origin: 50% 62%; }
    .k-lean { transform-box: fill-box; transform-origin: 50% 100%; transition: transform .22s ease-out; }
    .kk-run { transform-origin: 50% 100%; }
    .kick-leg { transform-origin: 50% 5%; }
    .arm { transform-origin: 50% 8%; }
    .ball { transform-origin: 50% 50%; }
    .k-sway { transform-box: fill-box; transform-origin: 50% 100%; animation: sway 1.5s ease-in-out infinite alternate; }
    .kk-sway { transform-box: fill-box; transform-origin: 50% 100%; animation: sway 2.1s ease-in-out infinite alternate; }
    @keyframes sway { from { transform: translateX(-1.4px) scaleY(1); } to { transform: translateX(1.4px) scaleY(1.012); } }

    .zone, .col { cursor: default; }
    .zone.live, .col.live { cursor: pointer; }
    .zone .ring { fill: rgba(255,255,255,.05); stroke: #fff; stroke-opacity: .45; stroke-width: 1.2; stroke-dasharray: 3 3; }
    .zone.live .ring { animation: breathe 1.8s ease-in-out infinite; }
    .zone.sel .ring { fill: rgba(245, 112, 31, .3); stroke: #f5701f; stroke-opacity: 1; stroke-dasharray: none; stroke-width: 1.8; animation: none; }
    .zone .reticle { opacity: 0; fill: none; stroke: #f5701f; stroke-width: 1.8; stroke-linecap: round; }
    .zone.sel .reticle { opacity: 1; }
    .zone.sel .reticle circle { animation: lock .28s cubic-bezier(.2, 1.4, .4, 1); transform-box: fill-box; transform-origin: 50% 50%; }
    @keyframes breathe { 50% { stroke-opacity: .9; fill: rgba(255,255,255,.12); } }
    @keyframes lock { from { transform: scale(2.2); opacity: 0; } to { transform: none; opacity: 1; } }
    .col .band { fill: rgba(255,255,255,.04); stroke: #fff; stroke-opacity: .25; stroke-width: 1; stroke-dasharray: 3 3; }
    .col.live .band { animation: breathe 1.8s ease-in-out infinite; }
    .col.sel .band { fill: rgba(245, 112, 31, .26); stroke: #f5701f; stroke-opacity: 1; stroke-dasharray: none; stroke-width: 1.8; animation: none; }
    .col .chev { fill: none; stroke: #fff; stroke-opacity: .55; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .col.sel .chev { stroke: #f5701f; stroke-opacity: 1; }

    .role-cap { position: absolute; left: 0; right: 0; top: 10px; text-align: center; font-family: var(--font-display); font-size: 30px; font-weight: 700; color: #fff; text-shadow: 0 2px 0 rgba(0,0,0,.45); pointer-events: none; animation: banner .35s cubic-bezier(.2, 1.3, .4, 1) both; }
    .count { position: absolute; left: 0; right: 0; top: 38%; text-align: center; font-family: var(--font-display); font-weight: 700; font-size: 96px; line-height: 1; color: #fff; text-shadow: 0 3px 0 rgba(0,0,0,.35); animation: pop .9s ease-out both; pointer-events: none; }
    @keyframes pop { 0% { transform: scale(.5); opacity: 0; } 25% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: .9; } }
    .banner { position: absolute; left: 0; right: 0; top: 33%; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; pointer-events: none; animation: banner .45s cubic-bezier(.2, 1.3, .4, 1) both; }
    .banner strong { font-family: var(--font-display); font-size: 58px; line-height: 1; letter-spacing: .01em; text-shadow: 0 3px 0 rgba(0,0,0,.4); }
    .banner span { color: #fff; font-size: 17px; font-weight: 600; background: rgba(12, 17, 14, .72); padding: 2px 10px; border-radius: 3px; }
    .banner[data-t='good'] strong { color: #5ccb8a; } .banner[data-t='bad'] strong { color: #f0805a; }
    @keyframes banner { from { transform: translateY(14px) scale(.7); opacity: 0; } to { transform: none; opacity: 1; } }

    .confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
    .confetti i { position: absolute; top: -8%; left: var(--x); width: 8px; height: 13px; opacity: 0; transform: rotate(var(--r)); }
    .confetti.on i { animation: fall 1.9s cubic-bezier(.3, .5, .6, 1) var(--d) both; }
    @keyframes fall { 0% { opacity: 1; transform: translate(0, 0) rotate(var(--r)); } 100% { opacity: 0; transform: translate(var(--drift), 420px) rotate(calc(var(--r) + 540deg)); } }
    @media (prefers-reduced-motion: reduce) { .k-sway, .kk-sway, .zone.live .ring, .col.live .band { animation: none; } .confetti { display: none; } }
  `],
})
export class ShootoutScene implements OnDestroy {
  /** Which controls to draw over the goal: six aiming spots for the kicker, three dive lanes for the keeper. */
  readonly mode = input<'KICKER' | 'KEEPER' | null>(null);
  readonly interactive = input(false);
  readonly aimZone = input<number | null>(null);
  readonly diveZone = input<number | null>(null);
  /** Who is kicking right now, for the kit colours (you are always orange). */
  readonly youKick = input(true);
  readonly countdown = input<number | null>(null);
  /** A short line over the pitch before a kick: "You shoot" / "You keep goal". */
  readonly caption = input<string | null>(null);
  readonly audio = input<ShootoutAudio | null>(null);
  readonly pickZone = output<number>();
  readonly pickDive = output<number>();
  /** Fires at the moment the ball reaches the goal (or the keeper): when the result becomes known on screen. */
  readonly contact = output<void>();

  protected zones = [0, 1, 2, 3, 4, 5];
  protected banner = signal<{ kind: string; title: string; sub: string; tone: 'good' | 'bad' } | null>(null);
  protected confetti = signal(false);
  protected pieces = Array.from({ length: 22 }, (_, i) => ({
    x: 4 + ((i * 37) % 92), d: (i % 7) * 55, r: (i * 53) % 180 - 90, drift: ((i % 5) - 2) * 18,
    c: ['#f5701f', '#eceae3', '#5ccb8a', '#d9b44a', '#6fa8dc'][i % 5],
  }));

  private crowd = viewChild.required<ElementRef<SVGGElement>>('crowd');
  private keeper = viewChild.required<ElementRef<SVGGElement>>('keeper');
  private armL = viewChild.required<ElementRef<SVGGElement>>('armL');
  private armR = viewChild.required<ElementRef<SVGGElement>>('armR');
  private ball = viewChild.required<ElementRef<SVGGElement>>('ball');
  private shadow = viewChild.required<ElementRef<SVGEllipseElement>>('shadow');
  private kicker = viewChild.required<ElementRef<SVGGElement>>('kicker');
  private kickLeg = viewChild.required<ElementRef<SVGGElement>>('kickLeg');
  private netBack = viewChild.required<ElementRef<SVGGElement>>('netBack');
  private ripple = viewChild.required<ElementRef<SVGCircleElement>>('ripple');
  private trail = viewChild.required<ElementRef<SVGPathElement>>('trail');
  private cam = viewChild.required<ElementRef<HTMLElement>>('cam');

  private anims: Animation[] = [];
  private run = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  /** Your keeper leans toward the spot you have picked (up on his toes for a high one), so the choice feels real. */
  protected lean = () => {
    if (this.mode() !== 'KEEPER') return 'none';
    const z = this.diveZone();
    if (z === null) return 'none';
    const c = zoneCol(z);
    const up = zoneIsHigh(z);
    const x = (c - 1) * 9;
    return `translate(${x}px,${up ? -3 : 1}px) rotate(${(c - 1) * 7}deg) scaleY(${up ? 1.07 : 0.95})`;
  };
  /** An arrow on each dive target pointing the way the keeper would go. */
  protected diveChev(z: number) {
    const cx = colX(zoneCol(z)); const cy = zoneIsHigh(z) ? 134 : 177; const c = zoneCol(z);
    const v = zoneIsHigh(z) ? -1 : 1;
    if (c === 1) return v < 0 ? `M ${cx - 8} ${cy + 5} l 8 -10 l 8 10` : `M ${cx - 8} ${cy - 5} l 8 10 l 8 -10`;
    return c === 0 ? `M ${cx + 4} ${cy - 8} l -8 8 l 8 8` : `M ${cx - 4} ${cy - 8} l 8 8 l -8 8`;
  }
  protected kickerKit = () => (this.youKick() ? ME : OPP);
  protected keeperKit = () => (this.youKick() ? OPP : ME);
  protected colCentre = colX;

  ngOnDestroy() { this.reset(); }

  protected onZone(ev: Event, z: number) { if (this.interactive()) { ev.preventDefault(); this.pickZone.emit(z); } }
  protected onDive(ev: Event, z: number) { if (this.interactive()) { ev.preventDefault(); this.pickDive.emit(z); } }

  private fx(el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const a = el.animate(keyframes, { fill: 'forwards', ...options });
    this.anims.push(a);
    return a;
  }

  /** Back to the starting stance: cancels everything, clears the banner. */
  reset() {
    this.run++;
    for (const a of this.anims) { try { a.cancel(); } catch { /* already gone */ } }
    this.anims = [];
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.banner.set(null);
    this.confetti.set(false);
  }

  private at(ms: number, fn: () => void) { this.timers.push(setTimeout(fn, ms)); }

  /**
   * Play one resolved kick: run-up, strike, the ball's flight, the keeper's
   * dive and what happens at the end of it. Resolves when the moment is over.
   */
  async play(k: KickReplay): Promise<void> {
    this.reset();
    const run = this.run;
    const rm = reducedMotion();
    const s = rm ? 0.01 : 1;
    const a = this.audio();
    a?.whistle();

    // The keeper reads the strike a beat early, so the dive begins as the boot connects.
    const dir = zoneCol(k.keeperZone) - 1;
    const kHigh = zoneIsHigh(k.keeperZone);
    const high = k.zone != null && zoneIsHigh(k.zone);

    if (k.zone == null) {
      // The kicker never shot: nothing leaves the spot.
      this.banner.set({ kind: 'MISSED', title: 'No shot', sub: k.meKicker ? 'You ran out of time' : 'They ran out of time', tone: k.meKicker ? 'bad' : 'good' });
      this.contact.emit();
      a?.groan(0.6);
      await wait(1400);
      if (run === this.run) this.reset();
      return;
    }

    const col = zoneCol(k.zone);
    const perfect = k.quality === 'PERFECT';
    const flight = (perfect ? 380 : 500) * s;
    const runUp = 520 * s;
    const strikeAt = runUp - 40 * s;
    const hitAt = strikeAt + flight;

    // Where the ball ends up (relative to the penalty spot).
    let tx = colX(col);
    let ty = zoneY(high);
    let endScale = 0.5;
    if (k.outcome === 'MISSED') {
      if (high) { tx = colX(col) + (col - 1) * 14; ty = 52; endScale = 0.3; }
      else { tx = col === 0 ? 14 : 346; ty = 178; endScale = 0.46; if (col === 1) tx = 346; }
    }
    const dx = tx - SPOT.x; const dy = ty - SPOT.y;
    const arc = high ? 46 : 20;

    // Run-up and strike.
    this.fx(this.kicker().nativeElement, [
      { transform: 'translate(0px,0px) scale(1)' },
      { transform: 'translate(-14px,-44px) scale(.9)', offset: 0.45 },
      { transform: 'translate(-26px,-84px) scale(.76)' },
    ], { duration: runUp, easing: 'cubic-bezier(.3,.1,.5,1)' });
    this.fx(this.kickLeg().nativeElement, [
      { transform: 'rotate(0deg)' }, { transform: 'rotate(-38deg)', offset: 0.6 }, { transform: 'rotate(48deg)' },
    ], { duration: runUp, easing: 'ease-in-out' });

    // The keeper dives (he leaves as the ball does).
    const keeperDelay = Math.max(0, strikeAt - 60 * s);
    const sideDive = dir !== 0;
    const saving = k.outcome === 'SAVED';
    // Goes where the keeper chose: up for a top corner (a leap, body upright-ish), down low for a bottom one.
    const rot = sideDive ? dir * (kHigh ? 52 : 82) : 0;
    const kdy = kHigh ? (sideDive ? -14 : -16) : 6;
    const kscale = sideDive ? 1 : (kHigh ? 1.04 : 0.84);
    // A perfect top-corner strike is unsavable even when he guessed the spot: he gets there late and just short, hands grasping at air.
    const beaten = k.outcome === 'GOAL' && k.keeperZone === k.zone;
    const reach = beaten ? 0.28 : 1;
    this.fx(this.keeper().nativeElement, [
      { transform: 'translate(0px,0px) rotate(0deg) scale(1)' },
      { transform: `translate(${dir * (COL_W * 0.92) * reach}px,${beaten ? kdy * 0.4 : kdy}px) rotate(${rot * (beaten ? 0.45 : 1)}deg) scale(${beaten ? 1 : kscale})` },
    ], { duration: (beaten ? 620 : 460) * s, delay: keeperDelay + (beaten ? 140 * s : 0), easing: 'cubic-bezier(.15,.75,.3,1)' });
    this.fx(this.armL().nativeElement, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${beaten ? 105 : kHigh ? 170 : sideDive ? 120 : 60}deg)` }], { duration: 260 * s, delay: keeperDelay, easing: 'ease-out' });
    this.fx(this.armR().nativeElement, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${beaten ? -105 : kHigh ? -170 : sideDive ? -120 : -60}deg)` }], { duration: 260 * s, delay: keeperDelay, easing: 'ease-out' });

    // Camera leans in on the strike.
    this.fx(this.cam().nativeElement, [
      { transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: 0.35 }, { transform: 'scale(1.045)' },
    ], { duration: (hitAt + 520) * 1, easing: 'ease-out' });

    this.fx(this.shadow().nativeElement, [{ opacity: 1 }, { opacity: 0 }], { duration: 80 * s, delay: strikeAt });
    if (perfect && k.outcome !== 'MISSED') {
      // A perfect strike leaves a streak across the pitch.
      const tr = this.trail().nativeElement;
      tr.setAttribute('d', `M${SPOT.x} ${SPOT.y} Q${(SPOT.x + tx) / 2} ${(SPOT.y + ty) / 2 - arc * 1.4} ${tx} ${ty}`);
      const len = tr.getTotalLength();
      tr.style.strokeDasharray = String(len);
      this.fx(tr, [{ strokeDashoffset: len, opacity: 0.8 }, { strokeDashoffset: 0, opacity: 0.8, offset: 0.55 }, { strokeDashoffset: 0, opacity: 0 }], { duration: flight + 450 * s, delay: strikeAt, easing: 'ease-out' });
    }
    this.at(strikeAt, () => { if (run === this.run) { a?.kick(); a?.buzz(14); } });
    // Ball flight.
    const keyframes: Keyframe[] = [
      { transform: 'translate(0px,0px) scale(1) rotate(0deg)', offset: 0 },
      { transform: `translate(${dx * 0.5}px,${dy * 0.5 - arc}px) scale(.76) rotate(380deg)`, offset: 0.5 },
      { transform: `translate(${dx}px,${dy}px) scale(${endScale}) rotate(760deg)`, offset: 1 },
    ];
    this.fx(this.ball().nativeElement, keyframes, { duration: flight, delay: strikeAt, easing: 'cubic-bezier(.2,.55,.35,1)' });

    // From the viewer's side: a goal for me, or a save / miss against me, is good news.
    const good = (k.meKicker && k.outcome === 'GOAL') || (!k.meKicker && k.outcome !== 'GOAL');
    const crowdUp = [
      { transform: 'translateY(0)' }, { transform: 'translateY(-5px)', offset: 0.2 }, { transform: 'translateY(0)', offset: 0.4 },
      { transform: 'translateY(-4px)', offset: 0.6 }, { transform: 'translateY(0)', offset: 0.8 }, { transform: 'translateY(-2px)' },
    ];
    const crowdDown = [{ transform: 'translateY(0)' }, { transform: 'translateY(2px)' }];

    // The moment of truth.
    this.at(hitAt, () => {
      if (run !== this.run) return;
      this.contact.emit();
      if (k.outcome === 'GOAL') {
        this.banner.set({ kind: 'GOAL', title: 'Goal!', sub: perfect ? (k.keeperZone === k.zone ? 'Perfect strike. Right spot, too quick' : 'Perfect strike') : (kHigh !== high ? (high ? 'Keeper went low, shot went high' : 'Keeper went high, shot went low') : 'Keeper went the wrong way'), tone: good ? 'good' : 'bad' });
        const ring = this.ripple().nativeElement;
        ring.setAttribute('cx', String(tx));
        ring.setAttribute('cy', String(ty));
        ring.style.transformBox = 'fill-box';
        ring.style.transformOrigin = '50% 50%';
        this.fx(ring, [{ transform: 'scale(.4)', opacity: 0.9 }, { transform: 'scale(7)', opacity: 0 }], { duration: 650 * s, easing: 'ease-out' });
        this.fx(this.netBack().nativeElement, [{ transform: 'translateY(0)' }, { transform: 'translateY(4px) scale(1.012)', offset: 0.3 }, { transform: 'translateY(0)' }], { duration: 520 * s });
        // The ball drops into the net.
        this.fx(this.ball().nativeElement, [
          { transform: `translate(${dx}px,${dy}px) scale(${endScale}) rotate(760deg)` },
          { transform: `translate(${dx * 0.97}px,${dy + 14}px) scale(${endScale * 0.95}) rotate(860deg)` },
        ], { duration: 320 * s, easing: 'ease-out' });
        this.fx(this.crowd().nativeElement, good ? crowdUp : crowdDown, { duration: (good ? 1500 : 600) * s });
        this.fx(this.cam().nativeElement, [
          { transform: 'scale(1.045) translate(0,0)' }, { transform: 'scale(1.045) translate(-3px,2px)', offset: 0.2 },
          { transform: 'scale(1.045) translate(3px,-2px)', offset: 0.45 }, { transform: 'scale(1.03) translate(0,0)' },
        ], { duration: 420 * s });
        if (k.meKicker) this.celebrate();
        if (good) a?.cheer(); else a?.groan();
        a?.buzz(good ? [30, 40, 60] : [60]);
      } else if (k.outcome === 'SAVED') {
        this.banner.set({ kind: 'SAVED', title: 'Saved!', sub: high ? 'Keeper got up to it' : 'Keeper got down to it', tone: good ? 'good' : 'bad' });
        // The ball is turned away.
        const away = (col === 1 ? (dx >= 0 ? 1 : -1) : col === 0 ? -1 : 1);
        this.fx(this.ball().nativeElement, [
          { transform: `translate(${dx}px,${dy}px) scale(${endScale}) rotate(760deg)` },
          { transform: `translate(${dx + away * 46}px,${dy + (high ? 26 : -10)}px) scale(${endScale * 1.15}) rotate(1020deg)` },
        ], { duration: 420 * s, easing: 'cubic-bezier(.2,.7,.4,1)' });
        this.fx(this.crowd().nativeElement, good ? crowdUp : crowdDown, { duration: (good ? 1500 : 600) * s });
        a?.save();
        if (good) a?.cheer(0.7); else a?.groan(0.8);
        a?.buzz(good ? [20, 30, 20] : [60]);
      } else {
        this.banner.set({ kind: 'MISSED', title: 'Missed!', sub: k.quality === 'POOR' ? (high ? 'Over the bar' : 'Wide of the post') : 'No shot', tone: good ? 'good' : 'bad' });
        this.fx(this.ball().nativeElement, [
          { transform: `translate(${dx}px,${dy}px) scale(${endScale}) rotate(760deg)`, opacity: 1 },
          { transform: `translate(${dx + (tx > SPOT.x ? 40 : -40)}px,${dy - (high ? 24 : 4)}px) scale(${endScale * 0.7}) rotate(1000deg)`, opacity: 0 },
        ], { duration: 500 * s, easing: 'ease-out' });
        this.fx(this.crowd().nativeElement, good ? crowdUp : crowdDown, { duration: (good ? 1300 : 600) * s });
        if (good) a?.cheer(0.5); else a?.groan();
        a?.buzz(good ? [20] : [90]);
      }
    });

    await wait(hitAt + 1500 * s);
    if (run === this.run) this.reset();
  }

  /** A burst of paper for a goal you scored or a shootout you won. */
  celebrate() {
    this.confetti.set(false);
    requestAnimationFrame(() => this.confetti.set(true));
    this.at(2300, () => this.confetti.set(false));
  }
}
