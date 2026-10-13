-- Supplementary research only; operational fixtures and settlements are unchanged.
CREATE TABLE football_history_team_links (
  source VARCHAR(30) NOT NULL,
  provider_team_id INT UNSIGNED NOT NULL,
  team_id INT UNSIGNED NOT NULL,
  provider_name VARCHAR(100) NOT NULL,
  country VARCHAR(80) NULL,
  PRIMARY KEY(source, provider_team_id),
  UNIQUE KEY uq_history_local_team(source, team_id),
  FOREIGN KEY(team_id) REFERENCES football_teams(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE football_history_api_usage (
  source VARCHAR(30) NOT NULL,
  usage_date DATE NOT NULL,
  requests INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY(source, usage_date)
) ENGINE=InnoDB;
