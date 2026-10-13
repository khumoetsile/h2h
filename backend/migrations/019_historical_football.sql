-- Research archives never enter the operational fixture/settlement lifecycle.
CREATE TABLE football_history_imports (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(30) NOT NULL,
  competition_code VARCHAR(10) NOT NULL,
  season VARCHAR(20) NOT NULL,
  source_url VARCHAR(255) NOT NULL,
  license VARCHAR(80) NOT NULL,
  etag VARCHAR(200) NULL,
  content_hash CHAR(64) NULL,
  raw_payload MEDIUMTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  match_count INT NOT NULL DEFAULT 0,
  last_checked_at DATETIME NULL,
  last_imported_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  UNIQUE KEY uq_history_import (source, competition_code, season)
) ENGINE=InnoDB;

CREATE TABLE football_team_aliases (
  source VARCHAR(30) NOT NULL,
  competition_code VARCHAR(10) NOT NULL,
  source_name VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  team_id INT UNSIGNED NOT NULL,
  resolution VARCHAR(30) NOT NULL,
  PRIMARY KEY (source, competition_code, source_name),
  KEY idx_history_alias_team (team_id),
  FOREIGN KEY (team_id) REFERENCES football_teams(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE football_history_matches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  import_id INT UNSIGNED NOT NULL,
  source_key CHAR(64) NOT NULL,
  competition_id INT UNSIGNED NOT NULL,
  season VARCHAR(20) NOT NULL,
  home_team_id INT UNSIGNED NOT NULL,
  away_team_id INT UNSIGNED NOT NULL,
  match_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  home_score SMALLINT UNSIGNED NULL,
  away_score SMALLINT UNSIGNED NULL,
  home_half_score SMALLINT UNSIGNED NULL,
  away_half_score SMALLINT UNSIGNED NULL,
  statistics JSON NULL,
  raw_record JSON NOT NULL,
  record_hash CHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_history_source_match (import_id, source_key),
  KEY idx_history_home_date (home_team_id, match_date),
  KEY idx_history_away_date (away_team_id, match_date),
  KEY idx_history_pair (home_team_id, away_team_id, competition_id, match_date),
  KEY idx_history_season (competition_id, season),
  FOREIGN KEY (import_id) REFERENCES football_history_imports(id),
  FOREIGN KEY (competition_id) REFERENCES football_competitions(id),
  FOREIGN KEY (home_team_id) REFERENCES football_teams(id),
  FOREIGN KEY (away_team_id) REFERENCES football_teams(id)
) ENGINE=InnoDB;

CREATE TABLE football_history_revisions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  previous_record JSON NOT NULL,
  previous_hash CHAR(64) NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES football_history_matches(id)
) ENGINE=InnoDB;
