-- Rivalis initial schema. ALL monetary values are DEMO funds (no real money).

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  username VARCHAR(20) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('PLAYER','ADMIN') NOT NULL DEFAULT 'PLAYER',
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  bio VARCHAR(160) NULL,
  avatar_color VARCHAR(7) NOT NULL DEFAULT '#3B82F6',
  is_demo_data TINYINT(1) NOT NULL DEFAULT 0,
  is_bot TINYINT(1) NOT NULL DEFAULT 0,
  last_login_at DATETIME NULL,
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id CHAR(36) PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  remember TINYINT(1) NOT NULL DEFAULT 0,
  user_agent VARCHAR(255) NULL,
  ip VARCHAR(64) NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE wallets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'BWP',
  available_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  locked_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_demo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wallets_user (user_id),
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_wallet_available_nonneg CHECK (available_balance >= 0),
  CONSTRAINT chk_wallet_locked_nonneg CHECK (locked_balance >= 0)
) ENGINE=InnoDB;

CREATE TABLE games (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(40) NOT NULL,
  name VARCHAR(60) NOT NULL,
  tagline VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  how_to_play TEXT NOT NULL,
  mode VARCHAR(10) NOT NULL DEFAULT '1v1',
  estimated_duration_seconds INT UNSIGNED NOT NULL,
  accent_color VARCHAR(7) NOT NULL DEFAULT '#22D3EE',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_games_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE matches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(12) NOT NULL,
  game_id INT UNSIGNED NOT NULL,
  stake DECIMAL(12,2) NOT NULL,
  pool DECIMAL(12,2) NOT NULL,
  fee_percent DECIMAL(5,2) NOT NULL,
  fee_amount DECIMAL(12,2) NOT NULL,
  prize DECIMAL(12,2) NOT NULL,
  status ENUM('WAITING','MATCHED','READY','IN_PROGRESS','COMPLETED','CANCELLED') NOT NULL DEFAULT 'WAITING',
  source ENUM('MATCHMAKING','CHALLENGE','DIRECT') NOT NULL DEFAULT 'MATCHMAKING',
  created_by INT UNSIGNED NOT NULL,
  winner_id INT UNSIGNED NULL,
  is_draw TINYINT(1) NOT NULL DEFAULT 0,
  seed BIGINT UNSIGNED NOT NULL,
  cancel_reason VARCHAR(160) NULL,
  result_reason VARCHAR(160) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 1,
  matched_at DATETIME NULL,
  ready_at DATETIME NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  settled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_matches_code (code),
  KEY idx_matches_queue (status, game_id, stake, created_at),
  KEY idx_matches_status_updated (status, updated_at),
  KEY idx_matches_completed (completed_at),
  CONSTRAINT fk_matches_game FOREIGN KEY (game_id) REFERENCES games(id),
  CONSTRAINT fk_matches_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_matches_winner FOREIGN KEY (winner_id) REFERENCES users(id),
  CONSTRAINT chk_matches_stake_pos CHECK (stake > 0)
) ENGINE=InnoDB;

CREATE TABLE match_players (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  slot TINYINT UNSIGNED NOT NULL,
  stake DECIMAL(12,2) NOT NULL,
  stake_locked TINYINT(1) NOT NULL DEFAULT 1,
  outcome ENUM('WIN','LOSS','DRAW','REFUNDED') NULL,
  payout DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ready_at DATETIME NULL,
  started_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_match_players_user (match_id, user_id),
  UNIQUE KEY uq_match_players_slot (match_id, slot),
  KEY idx_match_players_user (user_id, match_id),
  CONSTRAINT fk_mp_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE game_results (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  score INT NOT NULL DEFAULT 0,
  tiebreak INT NOT NULL DEFAULT 0,
  is_valid TINYINT(1) NOT NULL DEFAULT 1,
  invalid_reason VARCHAR(160) NULL,
  summary JSON NOT NULL,
  rounds JSON NOT NULL,
  client_elapsed_ms INT UNSIGNED NULL,
  server_elapsed_ms INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_game_results (match_id, user_id),
  CONSTRAINT fk_gr_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_gr_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(20) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  wallet_id INT UNSIGNED NOT NULL,
  type ENUM('DEPOSIT','WITHDRAWAL','GAME_ENTRY','GAME_WIN','REFUND') NOT NULL,
  direction ENUM('CREDIT','DEBIT') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  available_after DECIMAL(12,2) NOT NULL,
  locked_after DECIMAL(12,2) NOT NULL,
  description VARCHAR(200) NOT NULL,
  status ENUM('COMPLETED','DEMO_COMPLETED','PENDING','FAILED') NOT NULL DEFAULT 'COMPLETED',
  match_id INT UNSIGNED NULL,
  idempotency_key VARCHAR(80) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_transactions_reference (reference),
  UNIQUE KEY uq_transactions_idempotency (idempotency_key),
  KEY idx_transactions_user_created (user_id, created_at),
  KEY idx_transactions_type (type, created_at),
  KEY idx_transactions_match (match_id),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  CONSTRAINT fk_tx_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL,
  CONSTRAINT chk_tx_amount_pos CHECK (amount > 0)
) ENGINE=InnoDB;

CREATE TABLE challenges (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  challenger_id INT UNSIGNED NOT NULL,
  opponent_id INT UNSIGNED NOT NULL,
  game_id INT UNSIGNED NOT NULL,
  stake DECIMAL(12,2) NOT NULL,
  message VARCHAR(140) NULL,
  status ENUM('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  match_id INT UNSIGNED NULL,
  expires_at DATETIME NOT NULL,
  responded_at DATETIME NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_challenges_opponent (opponent_id, status),
  KEY idx_challenges_challenger (challenger_id, status),
  KEY idx_challenges_status_expiry (status, expires_at),
  CONSTRAINT fk_ch_challenger FOREIGN KEY (challenger_id) REFERENCES users(id),
  CONSTRAINT fk_ch_opponent FOREIGN KEY (opponent_id) REFERENCES users(id),
  CONSTRAINT fk_ch_game FOREIGN KEY (game_id) REFERENCES games(id),
  CONSTRAINT fk_ch_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL,
  CONSTRAINT chk_ch_not_self CHECK (challenger_id <> opponent_id)
) ENGINE=InnoDB;

CREATE TABLE notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(120) NOT NULL,
  message VARCHAR(255) NOT NULL,
  link VARCHAR(120) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  KEY idx_notifications_user (user_id, is_read, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE admin_settings (
  setting_key VARCHAR(60) PRIMARY KEY,
  setting_value JSON NOT NULL,
  description VARCHAR(200) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE admin_audit_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id INT UNSIGNED NOT NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id VARCHAR(40) NULL,
  details JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_admin FOREIGN KEY (admin_id) REFERENCES users(id)
) ENGINE=InnoDB;
