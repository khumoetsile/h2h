import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {ExperiencePreferences} from './experience-preferences';
import {AuthService} from './auth.service';
describe('optional experience preferences',()=>{
  beforeEach(()=>localStorage.clear());
  it('persists a skipped setup without copying another account’s interests',()=>{
    const user=signal({id:1});TestBed.configureTestingModule({providers:[{provide:AuthService,useValue:{user}}]});
    const prefs=TestBed.inject(ExperiencePreferences);expect(prefs.settings()).toBeNull();
    prefs.save([]);expect(prefs.settings()).toEqual({interests:[]});
    user.set({id:2});expect(prefs.settings()).toBeNull();prefs.save(['football']);
    expect(prefs.settings()?.interests).toEqual(['football']);user.set({id:1});expect(prefs.settings()?.interests).toEqual([]);
  });
});
