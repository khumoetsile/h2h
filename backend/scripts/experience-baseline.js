// Read-only aggregate baseline. Use the configured database deliberately; never emits account rows.
import {query,pool} from '../src/db.js';
try {
  const activation=await query(`SELECT COUNT(*) newPlayers,
    SUM(EXISTS(SELECT 1 FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.user_id=u.id AND m.status='COMPLETED' AND m.completed_at>=u.created_at AND m.completed_at<u.created_at+INTERVAL 1 DAY)
      OR EXISTS(SELECT 1 FROM daily_predictions d WHERE d.user_id=u.id AND d.submitted_at>=u.created_at AND d.submitted_at<u.created_at+INTERVAL 1 DAY)
      OR EXISTS(SELECT 1 FROM fantasy_arena_entries e WHERE e.user_id=u.id AND e.joined_at>=u.created_at AND e.joined_at<u.created_at+INTERVAL 1 DAY)) activatedWithin24h
    FROM users u WHERE u.role='PLAYER' AND u.is_bot=0 AND u.is_demo_data=0 AND u.created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY AND u.created_at<=UTC_TIMESTAMP()-INTERVAL 1 DAY`);
  const challenges=await query(`SELECT COUNT(*) created,SUM(c.status='ACCEPTED') accepted FROM challenges c JOIN users u ON u.id=c.challenger_id WHERE u.is_bot=0 AND u.is_demo_data=0 AND c.created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY`);
  const matches=await query(`SELECT COUNT(*) created,SUM(m.status='COMPLETED') completed,SUM(m.status='CANCELLED') cancelled FROM matches m JOIN users u ON u.id=m.created_by WHERE u.is_bot=0 AND u.is_demo_data=0 AND m.created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY AND m.source<>'PRACTICE'`);
  const predictions=await query(`SELECT COUNT(*) submissions,COUNT(DISTINCT d.user_id) players FROM daily_predictions d JOIN users u ON u.id=d.user_id WHERE u.is_bot=0 AND u.is_demo_data=0 AND d.submitted_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY`);
  const arenas=await query(`SELECT COUNT(*) entries,COUNT(DISTINCT e.user_id) players FROM fantasy_arena_entries e JOIN users u ON u.id=e.user_id WHERE u.is_bot=0 AND u.is_demo_data=0 AND e.joined_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY`);
  console.log(JSON.stringify({window:'Rolling 30 days in UTC; activation excludes immature 24-hour cohorts and seeded/bot accounts',activation:activation[0],challenges:challenges[0],matches:matches[0],predictions:predictions[0],arenas:arenas[0]},null,2));
} finally {await pool.end();}
