import { pool, query, queryOne } from '../db.js';
import { createArena, publishArena } from './fantasyArenaService.js';

// Reviewed football-data club identities; never fuzzy-match a youth/women's team.
const clubs = new Set(['57','61','64','65','66','73','67','58','5','4','3','721',
  '81','86','78','108','98','109','113','100','524','523','190','503','498','678','674']);
const leagues = new Set(['PL','CL','PD','SA','BL1','FL1']);

export function selectAutomaticSlips(fixtures) {
  const days = new Map();
  for (const f of fixtures) {
    if (!leagues.has(f.code)) continue;
    const popular = Number(clubs.has(String(f.home_provider_id))) + Number(clubs.has(String(f.away_provider_id)));
    if (!popular) continue;
    // Botswana calendar day, not the server's local timezone.
    const day = new Date(new Date(f.kickoff_at).getTime() + 2*3600000).toISOString().slice(0,10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({...f, popular});
  }
  return [...days].sort(([a],[b])=>a.localeCompare(b)).filter(([,rows])=>rows.length>=3)
    .slice(0,2).map(([day,rows])=>({day,fixtures:rows.sort((a,b)=>b.popular-a.popular ||
      Number(b.code==='PL')-Number(a.code==='PL') || new Date(a.kickoff_at)-new Date(b.kickoff_at) || a.id-b.id)
      .slice(0,5).sort((a,b)=>new Date(a.kickoff_at)-new Date(b.kickoff_at)||a.id-b.id)}));
}

export async function ensureAutomaticArenas() {
  const connection = await pool.getConnection();
  let acquired = false;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('h2h-automatic-arenas',0) AS acquired");
    acquired = !!lock.acquired;
    if (!acquired) return [];
    const admin = await queryOne("SELECT id FROM users WHERE role='ADMIN' AND status='ACTIVE' AND is_bot=0 ORDER BY id LIMIT 1");
    if (!admin) return [];
    const rows = await query(`SELECT f.id,f.kickoff_at,c.code,h.provider_team_id home_provider_id,a.provider_team_id away_provider_id
      FROM football_fixtures f JOIN football_competitions c ON c.id=f.competition_id
      JOIN football_teams h ON h.id=f.home_team_id JOIN football_teams a ON a.id=f.away_team_id
      WHERE c.is_enabled=1 AND f.provider='football-data' AND f.is_simulated=0 AND f.status='SCHEDULED'
      AND f.kickoff_at>DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 HOUR)
      AND f.kickoff_at<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY)
      AND f.last_synced_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 6 HOUR) ORDER BY f.kickoff_at,f.id`);
    const published = [];
    for (const slip of selectAutomaticSlips(rows)) {
      const key = `daily-major:${slip.day}`;
      let arena = await queryOne('SELECT id,status FROM fantasy_arenas WHERE automatic_key=?',[key]);
      if (arena && arena.status!=='DRAFT') continue;
      if (!arena) {
        const label = new Date(`${slip.day}T12:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});
        arena = await createArena(admin.id,{
          name:`Big Match Arena - ${label}`,
          description:'Automatically selected matches featuring leading clubs from the major European leagues and Champions League.',
          entryFee:20,feePercent:10,prizePercentages:[50,30,20],
          fixtures:slip.fixtures.map(f=>({fixtureId:f.id})),
        },{automaticKey:key});
      }
      await publishArena(admin.id,arena.id,{automatic:true});
      published.push(arena.id);
    }
    return published;
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('h2h-automatic-arenas')").catch(()=>{});
    connection.release();
  }
}
