import { Pipe, PipeTransform } from '@angular/core';
import { formatMoney, timeAgo } from '../core/format';

/** `{{ 20 | money }}` -> "P20.00", `{{ 20 | money:'demo' }}` -> "P20.00 DEMO", `'sign'` adds +/−. */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(value: number | null | undefined, ...flags: string[]) {
    return formatMoney(value, { demo: flags.includes('demo'), sign: flags.includes('sign') });
  }
}

@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(value: string | Date | null | undefined) { return timeAgo(value); }
}

@Pipe({ name: 'ms' })
export class MsPipe implements PipeTransform {
  transform(value: number | null | undefined) { return value == null ? '-' : `${Math.round(value)} ms`; }
}
