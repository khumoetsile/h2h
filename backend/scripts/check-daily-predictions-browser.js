// Real-browser regression against a disposable LOCAL database only.
// Set DB_NAME=h2h_daily_browser and optionally PLAYWRIGHT_PACKAGE_PATH.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
if (
  process.env.DB_NAME !== "h2h_daily_browser" ||
  process.env.DB_HOST !== "127.0.0.1"
)
  throw new Error(
    "This browser check requires DB_HOST=127.0.0.1 and DB_NAME=h2h_daily_browser. It resets that disposable database.",
  );
process.env.NODE_ENV = "development";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PACKAGE_PATH || "playwright",
);
const { migrate } = await import("./migrate.js");
const { seed } = await import("./seed.js");
const { pool, query, queryOne } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { publishDailyChallenge, settleDailyChallenge } =
  await import("../src/football/dailyPredictionService.js");
let browser, server, io;
const output = path.join(os.tmpdir(), "h2h-daily-browser-results");
await fs.mkdir(output, { recursive: true });
try {
  await migrate({ fresh: true, log: () => {} });
  await seed({ log: () => {} });
  const user = (await queryOne("SELECT id FROM users WHERE username='player'"))
    .id;
  const comp = (
    await query(
      "INSERT INTO football_competitions(provider,provider_competition_id,code,name) VALUES('football-data','browser-test-only','PL','Browser test only')",
    )
  ).insertId;
  const teams = [];
  for (let i = 0; i < 2; i++)
    teams.push(
      (
        await query(
          "INSERT INTO football_teams(provider,provider_team_id,name) VALUES('football-data',?,?)",
          ["browser-test-" + i, ["Test Club", "Other Test Club"][i]],
        )
      ).insertId,
    );
  const fixture = (
    await query(
      "INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,last_synced_at,research_eligible,score_duration) VALUES('football-data','browser-test-only',?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 MINUTE),'SCHEDULED',UTC_TIMESTAMP(),1,'REGULAR')",
      [comp, ...teams],
    )
  ).insertId;
  const c = await publishDailyChallenge(null, {
    fixtureId: fixture,
    referenceTeamId: teams[0],
  });
  ({ server, io } = createServer());
  await new Promise((resolve) => server.listen(33308, "127.0.0.1", resolve));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:33308/daily-predictions");
  await page
    .getByRole("heading", { name: "Daily Predictions", exact: true })
    .waitFor();
  await page.getByText("Sign in to predict", { exact: true }).waitFor();
  assert.equal(await page.locator(".choices").count(), 0);
  await page.getByText("Sign in to predict", { exact: true }).click();
  await page.locator("input[formcontrolname=identifier]").fill("player");
  await page.locator("input[formcontrolname=password]").fill("Player123!");
  await page.locator("form button[type=submit]").click();
  await page.locator(".choices button").first().waitFor();
  assert.deepEqual(
    (await page.locator(".choices button").allTextContents()).map((s) =>
      s.trim(),
    ),
    ["Win", "Draw", "Loss"],
  );
  const wallet = await queryOne(
    "SELECT available_balance,locked_balance FROM wallets WHERE user_id=?",
    [user],
  );
  await page.getByRole("button", { name: "Win", exact: true }).click();
  await page
    .getByRole("button", { name: "Submit Prediction", exact: true })
    .click();
  await page
    .getByText("Prediction submitted: Test Club Win", { exact: true })
    .waitFor();
  await page.locator(".community").waitFor();
  assert.deepEqual(
    await queryOne(
      "SELECT available_balance,locked_balance FROM wallets WHERE user_id=?",
      [user],
    ),
    wallet,
  );
  for (const width of [320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.locator("h1").click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: path.join(output, `daily-${width}.png`),
      fullPage: true,
    });
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      overflow.scroll <= overflow.width,
      `Horizontal overflow at ${width}: ${overflow.scroll}`,
    );
    const targets = await page
      .locator(".choices button")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().height),
      );
    assert.ok(targets.every((h) => h >= 44));
    console.log(`PASS ${width}px: no overflow, touch targets >=44px`);
  }
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  await page
    .getByRole("button", { name: "Update Prediction", exact: true })
    .click();
  await page
    .getByText("Prediction submitted: Test Club Draw", { exact: true })
    .waitFor();
  assert.equal(
    (
      await queryOne(
        "SELECT COUNT(*) n FROM daily_predictions WHERE user_id=? AND challenge_id=?",
        [user, c.id],
      )
    ).n,
    1,
  );
  await query(
    "UPDATE daily_predictions SET submitted_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),updated_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR) WHERE challenge_id=?",
    [c.id],
  );
  await query(
    "UPDATE football_fixtures SET status='LIVE',kickoff_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?",
    [fixture],
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("Match in progress · prediction locked", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".choices").count(), 0);
  await query(
    "UPDATE football_fixtures SET status='FINISHED',home_score=1,away_score=1,last_synced_at=UTC_TIMESTAMP() WHERE id=?",
    [fixture],
  );
  await settleDailyChallenge(c.id);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Correct · 1 point", { exact: true }).waitFor();
  await page.locator("#history select").selectOption("correct");
  await page.locator(".history-row").waitFor();
  await page.locator("#rankings select").selectOption("daily");
  await page.locator(".my-rank").waitFor();
  assert.match(await page.locator(".my-rank").textContent(), /#1/);
  await page.goto("http://127.0.0.1:33308/profile");
  await page
    .locator("app-daily-preview")
    .getByText("First Correct Prediction", { exact: true })
    .waitFor();
  await page
    .locator("app-daily-preview")
    .getByText("Your prediction was correct", { exact: true })
    .waitFor();
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (e) => errors.push(e.message));
  await query(
    "INSERT INTO football_fixtures(provider,provider_fixture_id,competition_id,home_team_id,away_team_id,kickoff_at,status,last_synced_at,research_eligible,score_duration) VALUES('football-data','browser-admin-only',?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY),'SCHEDULED',UTC_TIMESTAMP(),1,'REGULAR')",
    [comp, ...teams],
  );
  await adminPage.goto(
    "http://127.0.0.1:33308/login?next=%2Fadmin%2Fdaily-predictions",
  );
  await adminPage.locator("input[formcontrolname=identifier]").fill("admin");
  await adminPage.locator("input[formcontrolname=password]").fill("Admin123!");
  await adminPage.locator("form button[type=submit]").click();
  await adminPage.waitForURL("**/admin");
  await adminPage.goto("http://127.0.0.1:33308/admin/daily-predictions");
  await adminPage
    .getByRole("heading", { name: "Manage Daily Predictions", exact: true })
    .waitFor();
  await adminPage.locator("form select").first().selectOption({ index: 1 });
  await adminPage.locator("form select").nth(1).selectOption({ index: 1 });
  await adminPage
    .locator("form")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await adminPage.getByText("Challenge published.", { exact: true }).waitFor();
  await adminPage
    .locator("article")
    .first()
    .getByText("Test Club vs Other Test Club · Predict Other Test Club", {
      exact: true,
    })
    .waitFor();
  await adminPage
    .locator("article")
    .first()
    .locator("input")
    .fill("Provider result permanently unavailable in browser test");
  await adminPage
    .locator("article")
    .first()
    .getByRole("button", {
      name: "Permanently void with this reason",
      exact: true,
    })
    .click();
  await adminPage
    .getByText(
      "Challenge voided. Streaks, accuracy, points and achievements recalculated.",
      { exact: true },
    )
    .waitFor();
  console.log(
    "PASS administrator login, publication with away reference team, and audited void via UI",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS sign-in, submit, update, community privacy, wallet isolation, lock, verified result, history filter, leaderboard, profile achievements; no browser exceptions",
  );
  console.log(`Screenshots: ${output}`);
} finally {
  if (browser) await browser.close();
  if (io) await new Promise((resolve) => io.close(resolve));
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
