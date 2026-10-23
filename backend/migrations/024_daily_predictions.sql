CREATE TABLE daily_prediction_challenges (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  challenge_date DATE NOT NULL,
  slot SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  timezone VARCHAR(64) NOT NULL,
  fixture_id INT UNSIGNED NOT NULL,
  reference_team_id INT UNSIGNED NOT NULL,
  home_team_id INT UNSIGNED NOT NULL,
  away_team_id INT UNSIGNED NOT NULL,
  cutoff_at DATETIME(3) NOT NULL,
  locked_at DATETIME(3) NULL,
  status ENUM('OPEN','LOCKED','RESOLVED','VOID') NOT NULL DEFAULT 'OPEN',
  actual_result ENUM('WIN','DRAW','LOSS','VOID') NULL,
  result_home_score SMALLINT UNSIGNED NULL,
  result_away_score SMALLINT UNSIGNED NULL,
  reason VARCHAR(255) NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at DATETIME(3) NULL,
  UNIQUE KEY uq_daily_date_slot(challenge_date,slot),
  UNIQUE KEY uq_daily_fixture(fixture_id),
  KEY idx_daily_status(status,cutoff_at),
  FOREIGN KEY(fixture_id) REFERENCES football_fixtures(id),
  FOREIGN KEY(reference_team_id) REFERENCES football_teams(id),
  FOREIGN KEY(home_team_id) REFERENCES football_teams(id),
  FOREIGN KEY(away_team_id) REFERENCES football_teams(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE daily_predictions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  challenge_id INT UNSIGNED NOT NULL,
  pick ENUM('WIN','DRAW','LOSS') NOT NULL,
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_daily_user_challenge(user_id,challenge_id),
  KEY idx_daily_challenge_pick(challenge_id,pick),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(challenge_id) REFERENCES daily_prediction_challenges(id)
) ENGINE=InnoDB;
CREATE TABLE daily_prediction_stats (
  user_id INT UNSIGNED PRIMARY KEY,
  winning_streak INT UNSIGNED NOT NULL DEFAULT 0,
  participation_streak INT UNSIGNED NOT NULL DEFAULT 0,
  details JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE daily_prediction_achievements (
  user_id INT UNSIGNED NOT NULL,
  code VARCHAR(40) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  awarded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(user_id,code),
  FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE daily_prediction_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  challenge_id INT UNSIGNED NOT NULL,
  revision INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NULL,
  evidence JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_daily_revision(challenge_id,revision),
  FOREIGN KEY(challenge_id) REFERENCES daily_prediction_challenges(id),
  FOREIGN KEY(actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE daily_prediction_preferences (
  user_id INT UNSIGNED PRIMARY KEY,
  reminders TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE daily_prediction_notices (
  user_id INT UNSIGNED NOT NULL,
  notice_key VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id,notice_key),
  FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE daily_prediction_state (
  id TINYINT UNSIGNED PRIMARY KEY,
  last_rollup_date DATE NULL
) ENGINE=InnoDB;
INSERT INTO daily_prediction_state(id) VALUES (1);
