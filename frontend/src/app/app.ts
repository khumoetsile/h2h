import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectionBanner } from './shared/connection-banner';
import { SessionRecoveryBanner } from './shared/session-recovery-banner';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConnectionBanner, SessionRecoveryBanner],
  template: '<app-connection-banner /><app-session-recovery-banner /><router-outlet />',
})
export class App {}
