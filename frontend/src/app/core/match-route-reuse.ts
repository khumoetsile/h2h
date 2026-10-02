import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/**
 * A page that belongs to one match must never be reused for another: going from
 * /match/A/play to /match/B/play has to rebuild the page, or it would keep
 * showing (and polling) the old match's state.
 */
export class MatchRouteReuse extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot) {
    return super.shouldReuseRoute(future, curr) && future.params['code'] === curr.params['code'];
  }
}
