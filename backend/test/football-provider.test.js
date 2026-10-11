import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SportmonksProvider } from '../src/football/providers/sportmonksProvider.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const providerFixture = {
  id: 12345,
  league_id: 172,
  starting_at: '2026-10-11 12:00:00',
  season: { name: '2026/27' },
  state: { short_name: 'HT', name: 'Half Time' },
  participants: [
    { id: 10, name: 'Copenhagen', short_code: 'COP', image_path: 'https://images.example/copenhagen.png', meta: { location: 'home' } },
    { id: 20, name: 'Midtjylland', short_code: 'MID', meta: { location: 'away' } },
  ],
  scores: [
    { description: 'CURRENT', score: { participant: 'home', goals: 1 } },
    { description: 'CURRENT', score: { participant: 'away', goals: 0 } },
  ],
  statistics: [
    { participant_id: 10, type: { name: 'Ball Possession' }, data: { value: 61 } },
    { participant_id: 20, type: { name: 'Ball Possession' }, data: { value: 39 } },
    { participant_id: 10, type: { name: 'Shots Total' }, data: { value: 8 } },
    { participant_id: 20, type: { name: 'Shots Total' }, data: { value: 3 } },
    { participant_id: 10, type: { name: 'Shots on Target' }, data: { value: 4 } },
    { participant_id: 20, type: { name: 'Shots on Target' }, data: { value: 1 } },
    { participant_id: 10, type: { name: 'Corner Kicks' }, data: { value: 2 } },
    { participant_id: 20, type: { name: 'Corner Kicks' }, data: { value: 1 } },
    { participant_id: 10, type: { name: 'Yellow Cards' }, data: { value: 1 } },
    { participant_id: 10, type: { name: 'Red Cards' }, data: { value: 0 } },
  ],
  events: [
    { id: 302, participant_id: 10, minute: 36, sort_order: 3, type: { name: 'Yellowcard' }, player_name: 'Home Player', info: 'Foul' },
    { id: 301, participant_id: 10, minute: 36, sort_order: 2, type: { name: 'Goal' }, player_name: 'Scorer', related_player_name: 'Assister', result: '1-0' },
    { id: 300, participant_id: 20, minute: 20, sort_order: 1, type: { name: 'Substitution' }, player_name: 'Substitute', related_player_name: 'Replaced Player' },
  ],
  ballcoordinates: [
    { id: 41, timer: '36:10', x: '1.01', y: '0.49' },
    { id: 42, timer: '35:58', x: '0.32', y: '-0.02' },
  ],
};

describe('Sportmonks provider', () => {
  test('requires its backend credential and advertises real match data capabilities', async () => {
    assert.throws(() => new SportmonksProvider({ apiKey: '' }), /SPORTMONKS_API_KEY is required/);
    const provider = new SportmonksProvider({ apiKey: 'test-key' });
    assert.deepEqual(provider.capabilities(), { statistics: true, events: true });
    assert.deepEqual((await provider.listCompetitions()).map((competition) => competition.code), ['SM172', 'SM501']);
  });

  test('maps live fixture score, phase, supplied statistics, events and bounded genuine coordinates', async () => {
    const provider = new SportmonksProvider({ apiKey: 'test-key' });
    let requestUrl;
    globalThis.fetch = async (input, options) => {
      requestUrl = new URL(input);
      assert.equal(options.headers.Authorization, 'test-key');
      return { ok: true, json: async () => ({ data: [providerFixture] }) };
    };

    const [fixture] = await provider.getLiveFixtures();
    assert.equal(requestUrl.pathname, '/v3/football/livescores/inplay');
    assert.equal(requestUrl.searchParams.get('filters'), 'fixtureLeagues:172,501');
    assert.match(requestUrl.searchParams.get('include'), /events\.type/);
    assert.match(requestUrl.searchParams.get('include'), /statistics\.type/);
    assert.equal(requestUrl.searchParams.get('api_token'), null, 'the key is sent as a backend request header');
    assert.equal(fixture.providerId, '12345');
    assert.equal(fixture.competitionProviderId, '172');
    assert.equal(fixture.status, 'LIVE');
    assert.equal(fixture.phase, 'Half Time');
    assert.equal(fixture.homeScore, 1);
    assert.equal(fixture.awayScore, 0);
    assert.equal(fixture.stats.homePossession, 61);
    assert.equal(fixture.stats.awayShotsOnTarget, 1);
    assert.equal(fixture.stats.homeCards, 1);
    assert.equal(fixture.stats.firstGoalTeam, 'HOME');
    assert.deepEqual(fixture.events.map((event) => [event.providerEventId, event.sortOrder]), [['300', 1], ['301', 2], ['302', 3]]);
    assert.equal(fixture.events[1].detail, '1-0');
    assert.deepEqual(fixture.ballCoordinates, [
      { providerEventId: '42', timer: '35:58', x: 0.32, y: 0 },
      { providerEventId: '41', timer: '36:10', x: 1, y: 0.49 },
    ]);
  });

  test('loads only the two free-plan leagues and returns scheduled fixtures without fabricated stats', async () => {
    const provider = new SportmonksProvider({ apiKey: 'test-key' });
    let requestUrl;
    globalThis.fetch = async (input) => {
      requestUrl = new URL(input);
      return { ok: true, json: async () => ({ data: [{ ...providerFixture, state: { short_name: 'NS', name: 'Not Started' }, scores: [], events: [], statistics: [], ballcoordinates: [] }] }) };
    };
    const competitions = await provider.listCompetitions();
    assert.deepEqual(competitions.map((item) => item.providerId), ['172', '501']);
    const [fixture] = await provider.listUpcomingFixtures('SM172', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z');
    assert.equal(requestUrl.pathname, '/v3/football/fixtures/between/2026-10-01/2026-10-31');
    assert.equal(requestUrl.searchParams.get('filters'), 'fixtureLeagues:172');
    assert.equal(fixture.status, 'SCHEDULED');
    assert.equal(fixture.homeScore, null);
    assert.equal(fixture.statsAvailable, false);
    assert.deepEqual(fixture.stats, {});
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(fixture.ballCoordinates, []);
  });

  test('marks a verified finished scoreless match as having no first scorer', async () => {
    const provider = new SportmonksProvider({ apiKey: 'test-key' });
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          ...providerFixture,
          state: { short_name: 'FT', name: 'Full Time' },
          scores: [
            { description: 'CURRENT', score: { participant: 'home', goals: 0 } },
            { description: 'CURRENT', score: { participant: 'away', goals: 0 } },
          ],
          statistics: [],
          events: [],
        },
      }),
    });
    const fixture = await provider.getFixture('12345');
    assert.equal(fixture.status, 'FINISHED');
    assert.equal(fixture.stats.firstGoalTeam, 'NONE');
    assert.equal(fixture.statsAvailable, false);
  });

  test('falls back to live events and stats when optional ball coordinates are forbidden', async () => {
    const provider = new SportmonksProvider({ apiKey: 'test-key' });
    const urls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      urls.push(url);
      if (url.searchParams.get('include')?.includes('ballCoordinates')) {
        return { ok: false, status: 403, text: async () => 'ballCoordinates is unavailable on this plan' };
      }
      return { ok: true, json: async () => ({ data: [{ ...providerFixture, ballcoordinates: [] }] }) };
    };
    const [fixture] = await provider.getLiveFixtures();
    assert.equal(urls.length, 2);
    assert.equal(urls[1].searchParams.get('include')?.includes('ballCoordinates'), false);
    assert.equal(fixture.status, 'LIVE');
  });
});
