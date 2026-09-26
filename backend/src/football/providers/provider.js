/**
 * FootballDataProvider — the contract every football data source implements.
 * Head2Head never talks to an external football API from anywhere except
 * through one of these providers, and never from the browser. Swapping the
 * active provider (mock vs a real one) is a single environment variable
 * (FOOTBALL_PROVIDER) — nothing else in the app depends on a specific vendor.
 *
 * @typedef {Object} ProviderCompetition
 * @property {string} providerId
 * @property {string} code
 * @property {string} name
 * @property {string|null} country
 * @property {string|null} emblemUrl
 *
 * @typedef {Object} ProviderTeam
 * @property {string} providerId
 * @property {string} name
 * @property {string|null} shortName
 * @property {string|null} crestUrl
 *
 * @typedef {Object} ProviderFixture
 * @property {string} providerId
 * @property {string} competitionProviderId
 * @property {string|null} season
 * @property {ProviderTeam} homeTeam
 * @property {ProviderTeam} awayTeam
 * @property {string} kickoffAt ISO timestamp
 * @property {'SCHEDULED'|'LIVE'|'FINISHED'|'POSTPONED'|'CANCELLED'|'ABANDONED'} status
 * @property {number|null} minute
 * @property {number|null} homeScore
 * @property {number|null} awayScore
 * @property {boolean} statsAvailable
 * @property {{homeShots:?number, awayShots:?number, homeCorners:?number, awayCorners:?number, homeCards:?number, awayCards:?number, firstGoalTeam:?('HOME'|'AWAY'|'NONE')}} stats
 * @property {Array<{minute:?number, type:string, team:'HOME'|'AWAY', playerName:?string, detail:?string}>} events
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} statistics  Shots/corners/cards available
 * @property {boolean} events      Goal-by-goal timeline available (needed for "who scores first")
 */

/** @abstract */
export class FootballDataProvider {
  /** A short machine name, stored on every synced row as its provenance. */
  get name() { throw new Error('not implemented'); }

  /** @returns {ProviderCapabilities} */
  capabilities() { throw new Error('not implemented'); }

  /** @returns {Promise<ProviderCompetition[]>} */
  async listCompetitions() { throw new Error('not implemented'); }

  /** @returns {Promise<ProviderFixture[]>} */
  async listUpcomingFixtures(_competitionCode, _fromIso, _toIso) { throw new Error('not implemented'); }

  /** @returns {Promise<ProviderFixture|null>} */
  async getFixture(_providerFixtureId) { throw new Error('not implemented'); }
}
