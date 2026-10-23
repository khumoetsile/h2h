import { Challenge, MatchSummary } from './models';
import { Arena } from './fantasy-arena';
import { DailyOverview } from './daily-predictions';

export interface NextAction { title: string; detail: string; label: string; link: string; }
export function dashboardNextAction(active: MatchSummary[], incoming: Challenge[], daily: DailyOverview | null, arenas: Arena[], now: number): NextAction {
  const turn = active.find(m => m.chess?.isYourTurn);
  if (turn) return { title:'Your chess turn is ready', detail:`Continue your game${turn.opponent ? ' against ' + turn.opponent.username : ''}.`, label:'Make your move', link:`/chess/${turn.chess!.code}` };
  const actionable = active.find(m => m.category === 'SKILL_GAME' && ['MATCHED','READY','IN_PROGRESS'].includes(m.status) && !m.submitted);
  if (actionable) return {title:'Your match needs you', detail:`Continue ${actionable.game.name}. Review the current match status and deadline.`, label:'Resume match', link:`/match/${actionable.code}`};
  const invitation = incoming.find(c => c.status === 'PENDING' && Date.parse(c.expiresAt) > now);
  if (invitation) return { title:`${invitation.challenger.username} challenged you`, detail:'Review the game, demo entry and acceptance deadline.', label:'Review invitation', link:'/challenges?tab=incoming' };
  const prediction = daily?.challenges.find(c => c.canSubmit && !c.pick && Date.parse(c.cutoffAt ?? c.kickoffAt) > now);
  if (prediction) return { title:'Your free prediction is ready', detail:`${prediction.homeTeam} vs ${prediction.awayTeam}. No entry fee or wallet deduction.`, label:'Predict Win, Draw or Loss', link:'/daily-predictions' };
  const arena = arenas.find(a => a.mine && ['LOCKED','LIVE','SETTLING'].includes(a.status));
  if (arena) return { title:'Your arena is underway', detail:`Follow your picks and the provisional standings in ${arena.name}.`, label:'View my arena', link:`/arena/${arena.id}` };
  return {title:'What will you play today?', detail:'Explore free football analysis and predictions, or set up a game against a friend.', label:'Explore games', link:'/games'};
}
