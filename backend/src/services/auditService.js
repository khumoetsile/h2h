// Comprehensive, structured audit trail. Every important action across auth,
// match/challenge lifecycle, gameplay and wallet events is recorded here so
// a challenge's full history can be reconstructed from the database alone —
// "why did this player receive this amount", "why was this cancelled",
// "was this settled twice" must all be answerable without guessing.
//
// Audit rows are never updated or deleted by application code — they are an
// append-only record. Pass `tx` (from withTransaction) when recording an
// event that must only persist if the surrounding financial change commits;
// pass null for standalone events (e.g. a failed login, which has no
// transaction to attach to).
import { query } from '../db.js';

/**
 * @param {object|null} tx - an open withTransaction() handle, or null to write immediately.
 * @param {object} event
 * @param {'PLAYER'|'ADMIN'|'SYSTEM'|'BOT'} event.actorType
 * @param {number|null} [event.actorUserId]
 * @param {string} event.action - short stable code, e.g. "MATCH_CREATED", "CHALLENGE_ACCEPTED"
 * @param {string} event.entityType - e.g. "MATCH", "CHALLENGE", "WALLET", "USER", "SETTLEMENT"
 * @param {string|number|null} [event.entityId]
 * @param {number|null} [event.matchId]
 * @param {number|null} [event.challengeId]
 * @param {string|null} [event.requestId]
 * @param {string|null} [event.ip]
 * @param {string|null} [event.userAgent]
 * @param {string|null} [event.previousState]
 * @param {string|null} [event.newState]
 * @param {string|null} [event.reason]
 * @param {object|null} [event.metadata] - structured, non-sensitive detail (never raw passwords/tokens/answer keys)
 */
export async function recordAudit(tx, event) {
  const sql = `INSERT INTO audit_events
    (actor_type, actor_user_id, action, entity_type, entity_id, match_id, challenge_id, request_id, ip_address, user_agent, previous_state, new_state, reason, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    event.actorType,
    event.actorUserId ?? null,
    event.action,
    event.entityType,
    event.entityId != null ? String(event.entityId) : null,
    event.matchId ?? null,
    event.challengeId ?? null,
    event.requestId ?? null,
    (event.ip || null)?.toString().slice(0, 64) ?? null,
    (event.userAgent || null)?.toString().slice(0, 255) ?? null,
    event.previousState ?? null,
    event.newState ?? null,
    event.reason ? String(event.reason).slice(0, 255) : null,
    event.metadata ? JSON.stringify(event.metadata) : null,
  ];
  const run = async () => {
    try {
      if (tx) await tx.q(sql, params);
      else await query(sql, params);
    } catch (err) {
      // Never let audit logging break a real user-facing operation; a
      // failure here is itself worth knowing about, so surface it to stderr.
      console.error('audit event write failed', event.action, err);
    }
  };
  // Inside a transaction, write immediately (so it rolls back with everything
  // else — an audit row for a financial event that never happened would be
  // misleading), EXCEPT for events explicitly marked to survive rollback via
  // event.afterCommit, used for things like "settlement attempt rejected".
  if (tx && event.afterCommit) tx.afterCommit(run);
  else await run();
}

function parseMeta(v) {
  if (v == null) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

export async function listAuditEvents({
  userId, matchId, challengeId, action, entityType, actorType, from, to, q, page = 1, pageSize = 50,
} = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('ae.actor_user_id = ?'); params.push(userId); }
  if (matchId) { where.push('ae.match_id = ?'); params.push(matchId); }
  if (challengeId) { where.push('ae.challenge_id = ?'); params.push(challengeId); }
  if (action) { where.push('ae.action = ?'); params.push(action); }
  if (entityType) { where.push('ae.entity_type = ?'); params.push(entityType); }
  if (actorType) { where.push('ae.actor_type = ?'); params.push(actorType); }
  if (from) { where.push('ae.created_at >= ?'); params.push(new Date(from)); }
  if (to) { where.push('ae.created_at <= ?'); params.push(new Date(to)); }
  if (q) {
    where.push('(ae.action LIKE ? OR ae.reason LIKE ? OR ae.entity_id LIKE ? OR u.username LIKE ? OR m.code LIKE ?)');
    const s = `%${q}%`;
    params.push(s, s, s, s, s);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_user_id LEFT JOIN matches m ON m.id = ae.match_id ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT ae.*, u.username AS actor_username, m.code AS match_code
     FROM audit_events ae
     LEFT JOIN users u ON u.id = ae.actor_user_id
     LEFT JOIN matches m ON m.id = ae.match_id
     ${whereSql}
     ORDER BY ae.created_at DESC, ae.id DESC LIMIT ? OFFSET ?`,
    [...params, size, (pg - 1) * size],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      actorType: r.actor_type,
      actorUserId: r.actor_user_id,
      actorUsername: r.actor_username,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      matchId: r.match_id,
      matchCode: r.match_code,
      challengeId: r.challenge_id,
      requestId: r.request_id,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      previousState: r.previous_state,
      newState: r.new_state,
      reason: r.reason,
      metadata: parseMeta(r.metadata),
    })),
    total, page: pg, pageSize: size,
  };
}
