import { Component, inject, signal } from '@angular/core';
import { ExperienceMeasurement } from '../core/experience-measurement';
@Component({selector:'app-measurement-settings',template:`<section class="card settings"><h2>Help improve Head2Head</h2><p class="muted small">Optional first-party usage measurement for this account in this browser. We store page categories and selected actions with your account ID, a visit ID and timestamps. No form content, wallet amounts, IP addresses or third-party trackers. Off by default.</p><label><input type="checkbox" [checked]="measurement.enabled()" (change)="toggle($any($event.target).checked)"/> Allow optional usage measurement</label><p class="muted small">Turning this off stops new events. You can also delete previous measurement events for this account.</p><button class="btn btn-sm" [disabled]="busy()" (click)="erase()">Delete my usage events</button>@if(message()){<p role="status">{{message()}}</p>}</section>`,styles:[`.settings{display:flex;flex-direction:column;gap:12px;margin:16px 0}label{display:flex;align-items:center;gap:10px;min-height:48px}input{width:20px;height:20px}`]})
export class MeasurementSettings {
  protected measurement=inject(ExperienceMeasurement);
  protected busy=signal(false);protected message=signal('');
  protected toggle(v:boolean){this.message.set(this.measurement.enable(v)?'Preference saved.':'Could not save this preference.');}
  protected async erase(){this.measurement.enable(false);this.busy.set(true);try{await this.measurement.erase();this.message.set('Your usage events were deleted. Measurement is off.');}catch{this.message.set('Could not delete events. Please retry.');}finally{this.busy.set(false);}}
}
