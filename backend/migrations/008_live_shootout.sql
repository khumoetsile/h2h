-- Live, turn-based penalty shootout. One row per kick ("round"). In every round
-- one player is the kicker and the other the keeper; both choose in secret and
-- the server reveals the result only once both have locked in (or a deadline
-- passes and the missing choice is made for them).
--
--   starts_at / deadline    the round's decision window, stamped by the server
--   period_ms, phase        the kicker's timing bar for this round (from the match seed)
--   kicker_zone             0..5 = row * 3 + column (row 0 high, row 1 low; column 0 left, 1 centre, 2 right)
--   kicker_stop_ms          where the kicker says they stopped the bar, relative to starts_at
--   kicker_server_ms        how long after starts_at the request actually arrived (anti-tamper)
--   keeper_col              0..2 the column the keeper dives to
--   kicker_auto/keeper_auto the choice was made for the player because they ran out of time
--   outcome / quality       resolved result (NULL until both choices are in)
CREATE TABLE shootout_rounds (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  round_no SMALLINT UNSIGNED NOT NULL,
  kicker_id INT UNSIGNED NOT NULL,
  keeper_id INT UNSIGNED NOT NULL,
  period_ms SMALLINT UNSIGNED NOT NULL,
  phase DECIMAL(4,3) NOT NULL,
  starts_at DATETIME(3) NOT NULL,
  deadline DATETIME(3) NOT NULL,
  kicker_zone TINYINT UNSIGNED NULL,
  kicker_stop_ms INT NULL,
  kicker_server_ms INT NULL,
  kicker_at DATETIME(3) NULL,
  keeper_col TINYINT UNSIGNED NULL,
  keeper_at DATETIME(3) NULL,
  kicker_auto TINYINT(1) NOT NULL DEFAULT 0,
  keeper_auto TINYINT(1) NOT NULL DEFAULT 0,
  outcome ENUM('GOAL','SAVED','MISSED') NULL,
  quality ENUM('PERFECT','GOOD','POOR','NONE') NULL,
  marker DECIMAL(5,4) NULL,
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_shootout_round (match_id, round_no),
  KEY idx_shootout_due (resolved_at, deadline),
  CONSTRAINT fk_sr_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_kicker FOREIGN KEY (kicker_id) REFERENCES users(id),
  CONSTRAINT fk_sr_keeper FOREIGN KEY (keeper_id) REFERENCES users(id)
) ENGINE=InnoDB
