import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigStore } from '../core/config.store';

@Component({
  selector: 'app-help',
  imports: [RouterLink],
  template: ` <main class="page page-narrow stack">
    <a class="link" routerLink="/">Home</a>
    <h1>How to play &amp; get help</h1>
    <p class="text-2">
      Head2Head is a demo. All entries, prizes and balances are simulated; no real money moves.
    </p>
    <section class="card stack">
      <h2>Your first match</h2>
      <ol>
        <li>Choose a game and read its instructions.</li>
        <li>Choose your demo entry. Review the prize and cancellation terms before starting.</li>
        <li>Find an opponent, practise against a clearly labelled bot, or invite a friend.</li>
        <li>
          When your opponent arrives, tap <strong>I'm ready</strong>. Both players must be ready
          before the game starts.
        </li>
        <li>
          Complete the game. The result page shows the outcome and what happened to your demo entry.
        </li>
      </ol>
      <a class="btn btn-primary" routerLink="/games">Choose a game</a>
    </section>
    <section class="card stack">
      <h2>Waiting, leaving &amp; practice</h2>
      <p>
        While waiting for an opponent, you can leave for free and your entry is returned. Practice
        uses the same demo entry and prize rules as a match.
      </p>
      <p>
        After both players are ready, leaving costs {{ fee() }} in demo funds. Read the confirmation
        before leaving.
      </p>
      <p>
        If a connection drops, return to your active match. Follow the on-screen timer; the server
        decides the result.
      </p>
    </section>
    <section class="card stack">
      <h2>Chess across days</h2>
      <p>Invite a friend by username or share a chess link. Creating an invitation holds no funds. On acceptance, both demo entries are held and White moves first.</p>
      <p>Each turn has the deadline shown before you accept. Choose a piece, choose a legal destination, then confirm. Your progress is saved after each confirmed move, so you can leave and return from Challenges.</p>
      <p><strong>Missing your move deadline or resigning loses the game.</strong> The opponent receives the combined pool minus the disclosed platform fee. Waiting on a draw offer does not pause your deadline. Checkmate wins; agreed draws and automatic board draws refund both entries with no fee.</p>
      <p>Save your guest account before relying on another device. Reminders are helpful, but the displayed deadline applies even if a notification is not delivered.</p>
      <a class="btn" routerLink="/chess">Open chess</a>
    </section>
    <section class="card stack">
      <h2>Football</h2>
      <p>
        Browse fixtures and results without an account. A football challenge is between two players
        choosing opposing outcomes on a fixture. Challenges close at kickoff. Results come from the
        server; unresolved or cancelled fixtures are handled by the existing refund rules.
      </p>
    </section>
    <section class="card stack">
      <h2>Keep your account</h2>
      <p>
        Started as a guest? Save your account from your profile so you can sign in on another
        device. Email recovery requires a registered email address.
      </p>
      <a class="link" routerLink="/profile">Open my profile</a
      ><a class="link" routerLink="/forgot-password">Recover my password</a>
      @if (support()) {
        <a class="btn" [href]="'mailto:' + support()">Contact support</a>
      } @else {
        <p class="muted small">
          For account help, contact the site administrator through the channel where you received
          your invitation. A support email has not been published yet.
        </p>
      }
    </section>
  </main>`,
  styles: [
    `
      ol {
        margin: 0;
        padding-left: 24px;
      }
      li + li {
        margin-top: 10px;
      }
      .page > .link {
        padding-block: 12px;
      }
    `,
  ],
})
export class HelpPage {
  private config = inject(ConfigStore);
  protected fee = this.config.abandonmentFee;
  protected support = computed(() => this.config.config()?.recovery?.supportEmail ?? '');
}
