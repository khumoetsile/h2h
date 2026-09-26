import { config } from '../config.js';
import { MockFootballProvider } from './providers/mockProvider.js';
import { FootballDataOrgProvider } from './providers/footballDataOrgProvider.js';

let instance = null;

/** The single active FootballDataProvider, chosen by FOOTBALL_PROVIDER. */
export function getFootballProvider() {
  if (instance) return instance;
  switch (config.football.provider) {
    case 'football-data':
      instance = new FootballDataOrgProvider({ apiKey: config.football.apiKey, baseUrl: config.football.apiBaseUrl });
      break;
    case 'mock':
    default:
      instance = new MockFootballProvider();
      break;
  }
  return instance;
}
