import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { formatMoney } from './core/format';
import { markerAt } from './games/penalty-shootout';

describe('App', () => {
  it('creates the root component', async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([])] }).compileComponents();
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});

describe('formatMoney', () => {
  it('formats demo amounts', () => {
    expect(formatMoney(36)).toBe('P36.00');
    expect(formatMoney(1250.5, { demo: true })).toBe('P1,250.50 DEMO');
    expect(formatMoney(-20, { sign: true })).toBe('−P20.00');
    expect(formatMoney(16, { sign: true })).toBe('+P16.00');
  });
});

describe('penalty marker', () => {
  it('matches the server triangle wave', () => {
    expect(markerAt(1000, 0, 0)).toBe(0);
    expect(markerAt(1000, 0, 500)).toBe(1);
    expect(markerAt(1000, 0, 250)).toBeCloseTo(0.5);
  });
});
