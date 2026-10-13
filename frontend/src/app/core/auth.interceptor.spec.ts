import { HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { authInterceptor } from './auth.interceptor';

describe('session expiry while resuming chess', () => {
  let currentToken: string;
  let clear: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    currentToken = 'old-session'; clear = vi.fn(); navigate = vi.fn();
    TestBed.configureTestingModule({providers:[
      {provide:AuthService,useValue:{token:()=>currentToken,clear}},
      {provide:Router,useValue:{url:'/chess/M-SAVEDGAME',navigate}},
    ]});
  });
  function request() {
    const response = new Subject<never>();
    TestBed.runInInjectionContext(() => authInterceptor(new HttpRequest('GET','/api/me'),() => response)).subscribe({error:()=>{}});
    return response;
  }
  it('ignores an old request expiry after a new session has been established', () => {
    const response = request(); currentToken = 'new-session';
    response.error(new HttpErrorResponse({status:401}));
    expect(clear).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it('preserves the saved-game destination when the current session has expired', () => {
    request().error(new HttpErrorResponse({status:401}));
    expect(clear).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(['/login'],{queryParams:{reason:'expired',next:'/chess/M-SAVEDGAME'}});
  });
});
