-- Correspondence chess shares the demo wallet, settlements and match history.
-- Invitations carry no match and no reserved stake until both players accept.
ALTER TABLE games MODIFY COLUMN kind ENUM('SKILL','FOOTBALL','CHESS') NOT NULL DEFAULT 'SKILL';
ALTER TABLE matches MODIFY COLUMN category ENUM('SKILL_GAME','FOOTBALL','CHESS') NOT NULL DEFAULT 'SKILL_GAME';

INSERT INTO games (slug, kind, name, tagline, description, how_to_play, mode, estimated_duration_seconds, accent_color, sort_order)
VALUES ('chess', 'CHESS', 'Chess', 'Your next move, on your time',
  'Challenge a friend to correspondence chess. Progress is saved after every move. Each turn has a deadline so an opponent cannot leave your demo funds locked indefinitely.',
  'White moves first. Select a piece and a legal destination, then confirm your move. Each player has the stated time per turn. Missing that deadline or resigning loses the match. Checkmate wins; draws refund both entries with no platform fee.',
  '1v1', 86400, '#C6A56B', 2);

CREATE TABLE chess_games (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(12) NOT NULL,
  match_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NOT NULL,
  opponent_id INT UNSIGNED NULL,
  status ENUM('PENDING','ACTIVE','COMPLETED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  stake DECIMAL(12,2) NOT NULL,
  pool DECIMAL(12,2) NOT NULL,
  fee_percent DECIMAL(5,2) NOT NULL,
  fee_amount DECIMAL(12,2) NOT NULL,
  prize DECIMAL(12,2) NOT NULL,
  turn_seconds INT UNSIGNED NOT NULL,
  invite_expires_at DATETIME(3) NOT NULL,
  turn_deadline DATETIME(3) NULL,
  turn_user_id INT UNSIGNED NULL,
  fen VARCHAR(100) NOT NULL,
  pgn MEDIUMTEXT NOT NULL,
  moves JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  draw_offered_by INT UNSIGNED NULL,
  invite_end_reason VARCHAR(24) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  accepted_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_chess_code (code),
  UNIQUE KEY uq_chess_match (match_id),
  KEY idx_chess_deadline (status, turn_deadline),
  KEY idx_chess_invite (status, invite_expires_at),
  KEY idx_chess_creator (created_by, status),
  KEY idx_chess_opponent (opponent_id, status),
  CONSTRAINT fk_chess_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_chess_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_chess_opponent FOREIGN KEY (opponent_id) REFERENCES users(id),
  CONSTRAINT fk_chess_turn FOREIGN KEY (turn_user_id) REFERENCES users(id),
  CONSTRAINT fk_chess_draw_offer FOREIGN KEY (draw_offered_by) REFERENCES users(id),
  CONSTRAINT chk_chess_stake CHECK (stake > 0)
) ENGINE=InnoDB;
