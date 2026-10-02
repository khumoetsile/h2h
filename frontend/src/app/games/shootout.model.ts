/** Shapes and constants for the live penalty shootout. The rules themselves run on the server. */

export type ShootoutRole = 'KICKER' | 'KEEPER';
export type KickOutcome = 'GOAL' | 'SAVED' | 'MISSED';
export type KickQuality = 'PERFECT' | 'GOOD' | 'POOR' | 'NONE';

export interface ShootoutRound {
  no: number;
  kickerId: number;
  keeperId: number;
  role: ShootoutRole;
  startsAt: string;
  deadline: string;
  /** Only the kicker is given the timing bar. */
  timing: { periodMs: number; phase: number } | null;
  myLocked: boolean;
  opponentLocked: boolean;
}

export interface ShootoutKick {
  no: number;
  kickerId: number;
  keeperId: number;
  zone: number | null;
  keeperZone: number;
  outcome: KickOutcome;
  quality: KickQuality;
  marker: number | null;
  kickerAuto: boolean;
  keeperAuto: boolean;
}

export interface ShootoutState {
  code: string;
  matchStatus: string;
  phase: 'LOBBY' | 'ROUND' | 'FINISHED';
  serverNow: string;
  viewerId: number;
  firstKickerId: number;
  players: { userId: number; username: string; avatarColor: string; isBot: boolean; onPitch: boolean }[];
  goals: Record<number, number>;
  kicksTaken: Record<number, number>;
  suddenDeath: boolean;
  /** While waiting for the other player to take the pitch: when they run out of time. */
  lobbyDeadline: string | null;
  kicksPerSide: number;
  decisionMs: number;
  done: boolean;
  winnerId: number | null;
  current: ShootoutRound | null;
  history: ShootoutKick[];
  myChoice: { zone?: number } | null;
}

// Timing bar bands: distance of the stop from the centre, as a fraction of the track (matches the server).
export const PERFECT_BAND = 0.09;
export const HIGH_BAND = 0.25;
export const LOW_BAND = 0.4;

/** Marker position 0..1 (triangle wave) at time t. Same function the server uses. */
export function markerAt(periodMs: number, phase: number, t: number) {
  const p = ((t / periodMs) + phase) % 1;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

export const zoneCol = (z: number) => z % 3;
export const zoneIsHigh = (z: number) => z < 3;

export const ZONE_NAMES = ['top left', 'top centre', 'top right', 'bottom left', 'bottom centre', 'bottom right'];
export const COL_NAMES = ['left', 'centre', 'right'];
