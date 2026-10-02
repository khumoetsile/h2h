-- Comprehensive audit trail. Distinct from `system_errors` (background job /
-- provider failures) and the pre-existing `admin_audit_log` (kept as-is for
-- backward compatibility) — this table records every important action across
-- auth, match/challenge lifecycle, gameplay and wallet events so any
-- challenge's full history can be reconstructed from the database alone.
--
-- Foreign keys use ON DELETE SET NULL rather than CASCADE: if a related
-- match/challenge/user row were ever deleted, the audit record must survive
-- (audit trails must never disappear because of an application-level delete).
CREATE TABLE audit_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_type ENUM('PLAYER','ADMIN','SYSTEM','BOT') NOT NULL,
  actor_user_id INT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id VARCHAR(40) NULL,
  match_id INT UNSIGNED NULL,
  challenge_id INT UNSIGNED NULL,
  request_id VARCHAR(40) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  previous_state VARCHAR(30) NULL,
  new_state VARCHAR(30) NULL,
  reason VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_match (match_id),
  KEY idx_audit_challenge (challenge_id),
  KEY idx_audit_actor (actor_user_id),
  KEY idx_audit_action (action),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_challenge FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The loser's locked stake was previously released with no ledger row at all
-- (see walletService.forfeitStake) — every wallet balance change must have a
-- corresponding transaction record, so a FORFEIT type is added and the
-- service is updated to use it with its own idempotency key.
ALTER TABLE transactions MODIFY COLUMN type ENUM('DEPOSIT','WITHDRAWAL','GAME_ENTRY','GAME_WIN','REFUND','FORFEIT') NOT NULL;
