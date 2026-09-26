import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectionBanner } from './shared/connection-banner';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConnectionBanner],
  template: '<app-connection-banner /><router-outlet />',
})
export class App {}
