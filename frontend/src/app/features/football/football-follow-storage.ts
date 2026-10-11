const FOLLOWED_FIXTURES_KEY = 'h2h-football-followed';

export function readGuestFollowedFixtures(): number[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(FOLLOWED_FIXTURES_KEY) || '[]');
    return Array.isArray(values)
      ? [...new Set(values.filter((value): value is number => Number.isSafeInteger(value) && value > 0))].slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

export function writeGuestFollowedFixtures(ids: number[]): boolean {
  try {
    localStorage.setItem(FOLLOWED_FIXTURES_KEY, JSON.stringify([...new Set(ids)].slice(0, 100)));
    return true;
  } catch {
    return false;
  }
}
