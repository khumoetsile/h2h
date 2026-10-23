import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {signal} from '@angular/core';
import {ExperienceMeasurement,measurementSurface} from './experience-measurement';
import {AuthService} from './auth.service';
import {Api} from './api.service';
describe('optional usage measurement',()=>{
  beforeEach(()=>localStorage.clear());
  it('never records by default and scopes consent to an account',()=>{
    const user=signal<{id:number}|null>({id:1});const post=vi.fn().mockResolvedValue({});
    TestBed.configureTestingModule({providers:[provideRouter([]),{provide:AuthService,useValue:{user}},{provide:Api,useValue:{post}}]});
    const m=TestBed.inject(ExperienceMeasurement);
    m.record('page_view','home');expect(post).not.toHaveBeenCalled();
    m.enable(true);m.record('page_view','home');expect(post).toHaveBeenCalledTimes(1);
    user.set({id:2});m.record('page_view','home');expect(post).toHaveBeenCalledTimes(1);
    user.set(null);m.record('page_view','home');expect(post).toHaveBeenCalledTimes(1);
  });
  it('sends a category rather than sensitive route/query data',()=>{
    expect(measurementSurface('/football/95?token=secret#analysis')).toBe('analysis');
    expect(measurementSurface('/wallet/transactions?amount=10')).toBeNull();
    expect(measurementSurface('/reset-password?token=secret')).toBeNull();
    expect(measurementSurface('/admin/users')).toBeNull();
  });
});
