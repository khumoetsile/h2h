import { Component } from '@angular/core';

/** The picture on the front door and the Play card: a keeper diving at a shot into the top corner. */
@Component({
  selector: 'app-pitch-art',
  template: `
    <svg viewBox="0 0 360 200" aria-hidden="true">
      <rect width="360" height="200" fill="#1c3827"/>
      <g fill="#234632"><rect y="0" width="360" height="25"/><rect y="50" width="360" height="25"/><rect y="100" width="360" height="25"/><rect y="150" width="360" height="25"/></g>
      <path d="M0 160H360" stroke="#fff" stroke-opacity=".55" stroke-width="2"/>
      <path d="M118 160V138H242V160" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2"/>
      <!-- goal -->
      <rect x="70" y="34" width="220" height="104" fill="#0d1a12" fill-opacity=".35"/>
      <g stroke="#fff" stroke-opacity=".25" stroke-width="1"><path d="M70 60H290M70 86H290M70 112H290M107 34V138M144 34V138M181 34V138M218 34V138M255 34V138"/></g>
      <rect x="70" y="34" width="220" height="104" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
      <!-- ball, just under the top-left corner -->
      <g transform="translate(106 58)">
        <path d="M-60 100Q-20 60 -4 8" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-dasharray="3 5"/>
        <circle r="11" fill="#fff" stroke="#14100c" stroke-width="1.5"/>
        <path d="M0 -5l5 3.6-2 6h-6l-2-6z" fill="#14100c"/>
      </g>
      <!-- keeper, stretching for it and a little too late -->
      <g transform="translate(168 118) rotate(-24)">
        <rect x="-12" y="-52" width="24" height="34" rx="7" fill="#f5701f"/>
        <circle cx="0" cy="-62" r="9.5" fill="#e8c9a6"/>
        <rect x="-5" y="-17" width="10" height="26" rx="4" fill="#14100c"/>
        <path d="M-8 -48Q-16 -61 -27 -79" fill="none" stroke="#f5701f" stroke-width="8" stroke-linecap="round"/>
        <g transform="translate(-29 -82) rotate(-28)">
          <path d="M-4 4Q-7 1 -6 -2L-4 -7Q-3 -9 -1 -7L0 -4L1 -9Q2 -11 4 -9L4 -4L6 -7Q8 -8 8 -5L7 -1Q10 -2 10 1L7 6Q6 8 3 8H-1Q-4 8 -4 4Z" fill="#fff" stroke="#d9ddd8" stroke-width="1"/>
          <path d="M-4 3L-7 2Q-9 1 -8 -1Q-7 -3 -5 -2L-2 0" fill="#fff" stroke="#d9ddd8" stroke-width="1"/>
          <path d="M-3 7H5L4 11H-2Z" fill="#f5701f"/>
        </g>
        <path d="M8 -47Q17 -56 20 -68" fill="none" stroke="#f5701f" stroke-width="8" stroke-linecap="round"/>
        <g transform="translate(20 -71) rotate(18)">
          <path d="M-4 4Q-7 1 -6 -2L-4 -7Q-3 -9 -1 -7L0 -4L1 -9Q2 -11 4 -9L4 -4L6 -7Q8 -8 8 -5L7 -1Q10 -2 10 1L7 6Q6 8 3 8H-1Q-4 8 -4 4Z" fill="#fff" stroke="#d9ddd8" stroke-width="1"/>
          <path d="M-4 3L-7 2Q-9 1 -8 -1Q-7 -3 -5 -2L-2 0" fill="#fff" stroke="#d9ddd8" stroke-width="1"/>
          <path d="M-3 7H5L4 11H-2Z" fill="#f5701f"/>
        </g>
      </g>
    </svg>
  `,
  styles: [`:host { display: block; } svg { width: 100%; display: block; }`],
})
export class PitchArt {}
