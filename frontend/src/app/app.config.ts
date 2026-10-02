import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, RouteReuseStrategy, TitleStrategy, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { MatchRouteReuse } from './core/match-route-reuse';
import { BrandTitleStrategy } from './core/title-strategy';
import { MatIconRegistry } from '@angular/material/icon';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth.interceptor';
import { AuthService } from './core/auth.service';
import { ConfigStore } from './core/config.store';
import { PwaService } from './core/pwa.service';
import { RealtimeService } from './core/realtime.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: TitleStrategy, useClass: BrandTitleStrategy },
    { provide: RouteReuseStrategy, useClass: MatchRouteReuse },
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline', subscriptSizing: 'dynamic' } },
    provideAppInitializer(async () => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-rounded');
      inject(RealtimeService); // start listening to auth changes
      inject(PwaService).init(); // install prompt + service worker
      await Promise.all([inject(AuthService).init(), inject(ConfigStore).load()]);
    }),
  ],
};
