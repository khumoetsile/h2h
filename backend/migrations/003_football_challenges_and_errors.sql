-- Extend the existing pending-challenge table with optional football fields
-- (nullable, so skill-game challenges are completely unaffected) rather than
-- duplicating the whole challenge lifecycle for football.
ALTER TABLE challenges
  ADD COLUMN fixture_id INT UNSIGNED NULL AFTER game_id,
  ADD COLUMN challenge_type_id INT UNSIGNED NULL AFTER fixture_id,
  ADD COLUMN creator_pick ENUM('HOME','AWAY','YES','NO') NULL AFTER challenge_type_id,
  ADD CONSTRAINT fk_challenges_fixture FOREIGN KEY (fixture_id) REFERENCES football_fixtures(id),
  ADD CONSTRAINT fk_challenges_type FOREIGN KEY (challenge_type_id) REFERENCES football_challenge_types(id);

-- Admin-visible log of provider/sync failures ("system errors" per the admin
-- requirements) — separate from admin_audit_log, which records deliberate
-- admin actions rather than background failures.
CREATE TABLE system_errors (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(60) NOT NULL,
  message VARCHAR(500) NOT NULL,
  detail TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_system_errors_created (created_at)
) ENGINE=InnoDB;
