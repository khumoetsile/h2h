import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ah } from '../utils/errors.js';

const router = Router();
const event = z.object({
  eventId:z.string().uuid(), visitId:z.string().uuid(),
  event:z.enum(['page_view','primary_action','empty_recovery','onboarding_saved']),
  surface:z.enum(['home','games','football','analysis','predictions','arena','challenges','matches','rankings','profile']),
}).strict();
router.post('/events', rateLimit({windowMs:60000,limit:60,standardHeaders:true,legacyHeaders:false}), validate(event), ah(async (req,res) => {
  const e=req.body;
  await query('INSERT IGNORE INTO experience_events(event_id,user_id,visit_id,event_name,surface) VALUES(?,?,?,?,?)',[e.eventId,req.user.id,e.visitId,e.event,e.surface]);
  res.status(204).end();
}));
router.delete('/events', ah(async(req,res)=>{
  await query('DELETE FROM experience_events WHERE user_id=?',[req.user.id]);
  res.status(204).end();
}));
router.get('/summary', requireAdmin, ah(async (_req,res)=>{
  const [daily,active,retention] = await Promise.all([
    query(`SELECT DATE_FORMAT(created_at,'%Y-%m-%d') day, COUNT(DISTINCT user_id) users,COUNT(DISTINCT visit_id) visits,
      SUM(event_name='primary_action') primaryActions,SUM(event_name='empty_recovery') recoveries
      FROM experience_events WHERE created_at>=UTC_DATE()-INTERVAL 30 DAY GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d') ORDER BY day DESC`),
    query(`SELECT COUNT(DISTINCT CASE WHEN created_at>=UTC_TIMESTAMP()-INTERVAL 1 DAY THEN user_id END) dailyActive,
      COUNT(DISTINCT user_id) weeklyActive FROM experience_events WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY`),
    Promise.all([1,7,30].map(days=>query(`WITH first_visit AS (SELECT user_id,MIN(DATE(created_at)) first_day FROM experience_events GROUP BY user_id)
      SELECT ? days,COUNT(*) eligible,SUM(EXISTS(SELECT 1 FROM experience_events e WHERE e.user_id=f.user_id AND DATE(e.created_at)=DATE_ADD(f.first_day,INTERVAL ${days} DAY))) returned
      FROM first_visit f WHERE f.first_day<=UTC_DATE()-INTERVAL ${days} DAY`,[days]))),
  ]);
  res.set('Cache-Control','private, no-store').json({daily,active:active[0],retention:retention.flat(),scope:'Opt-in signed-in visitors only; exact UTC return days from first observed visit. Not a whole-site retention claim.'});
}));
export default router;
