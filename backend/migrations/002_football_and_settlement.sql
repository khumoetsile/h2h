-- Head2Head: Football category, generalized settlement ledger, and light
-- forward-compatibility columns for future real-money compliance controls.
-- All monetary values remain DEMO funds — see README "Regulatory status".

-- ---------------------------------------------------------------------------
-- Games: distinguish skill-games (Reaction Rush etc.) from the Football
-- pseudo-game used only to keep matches.game_id populated for football
-- competitions, so all existing generic match/wallet/stats code keeps working
-- unchanged. The Football tab never queries this row directly — it is
-- filtered out of the normal game catalogue by `kind`.
-- ---------------------------------------------------------------------------
ALTER TABLE games ADD COLUMN kind ENUM('SKILL','FOOTBALL') NOT NULL DEFAULT 'SKILL' AFTER slug;

-- ---------------------------------------------------------------------------
-- Matches: a football head-to-head reuses the entire existing match/wallet
-- lifecycle (locking, settlement, refunds, idempotency) — `category` just
-- tells the settlement layer which engine resolves the outcome, and `VOID`
-- is a new terminal status distinct from CANCELLED: CANCELLED means the
-- competition never got a fair chance to happen (no opponent, admin action,
-- left before start); VOID means it started fairly but could not be
-- objectively settled afterwards (fixture abandoned, data unavailable).
-- Both refund in full with zero platform fee — never charge a fee without a
-- genuine winner.
-- ---------------------------------------------------------------------------
ALTER TABLE matches
  ADD COLUMN category ENUM('SKILL_GAME','FOOTBALL') NOT NULL DEFAULT 'SKILL_GAME' AFTER game_id,
  MODIFY COLUMN status ENUM('WAITING','MATCHED','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOID') NOT NULL DEFAULT 'WAITING',
  MODIFY COLUMN source ENUM('MATCHMAKING','CHALLENGE','DIRECT') NOT NULL DEFAULT 'MATCHMAKING';

CREATE TABLE settlements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  reference VARCHAR(24) NOT NULL,
  outcome ENUM('WIN','DRAW','CANCELLED','VOID') NOT NULL,
  winner_id INT UNSIGNED NULL,
  pool DECIMAL(12,2) NOT NULL,
  fee_percent DECIMAL(5,2) NOT NULL,
  fee_amount DECIMAL(12,2) NOT NULL,
  prize DECIMAL(12,2) NOT NULL,
  reason VARCHAR(200) NULL,
  settled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The UNIQUE constraint on match_id is a second, DB-enforced guarantee
  -- (on top of matches.settled_at and each transaction's idempotency_key)
  -- that a competition can never be settled twice.
  UNIQUE KEY uq_settlements_match (match_id),
  UNIQUE KEY uq_settlements_reference (reference),
  CONSTRAINT fk_settlements_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_settlements_winner FOREIGN KEY (winner_id) REFERENCES users(id),
  CONSTRAINT chk_settlements_fee_only_on_win CHECK (outcome = 'WIN' OR fee_amount = 0)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Football reference data (competitions/teams/fixtures/events) — synced from
-- whichever FootballDataProvider is configured. Never queried live from the
-- browser; the frontend only ever reads from these tables via our own API.
-- ---------------------------------------------------------------------------
CREATE TABLE football_competitions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  provider_competition_id VARCHAR(40) NOT NULL,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(100) NOT NULL,
  country VARCHAR(60) NULL,
  emblem_url VARCHAR(255) NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_competitions_provider (provider, provider_competition_id)
) ENGINE=InnoDB;

CREATE TABLE football_teams (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  provider_team_id VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  short_name VARCHAR(60) NULL,
  crest_url VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_teams_provider (provider, provider_team_id)
) ENGINE=InnoDB;

CREATE TABLE football_fixtures (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  provider_fixture_id VARCHAR(40) NOT NULL,
  competition_id INT UNSIGNED NOT NULL,
  season VARCHAR(20) NULL,
  home_team_id INT UNSIGNED NOT NULL,
  away_team_id INT UNSIGNED NOT NULL,
  kickoff_at DATETIME NOT NULL,
  status ENUM('SCHEDULED','LIVE','FINISHED','POSTPONED','CANCELLED','ABANDONED') NOT NULL DEFAULT 'SCHEDULED',
  minute SMALLINT UNSIGNED NULL,
  home_score TINYINT UNSIGNED NULL,
  away_score TINYINT UNSIGNED NULL,
  -- Statistics are only ever populated by providers that declare
  -- supportsStatistics() — see footballProviders/capabilities. NULL means
  -- "not known", which is different from 0 and must never be treated as 0
  -- when settling a stats-based challenge.
  home_shots TINYINT UNSIGNED NULL,
  away_shots TINYINT UNSIGNED NULL,
  home_corners TINYINT UNSIGNED NULL,
  away_corners TINYINT UNSIGNED NULL,
  home_cards TINYINT UNSIGNED NULL,
  away_cards TINYINT UNSIGNED NULL,
  first_goal_team ENUM('HOME','AWAY','NONE') NULL,
  stats_available TINYINT(1) NOT NULL DEFAULT 0,
  is_simulated TINYINT(1) NOT NULL DEFAULT 0,
  last_synced_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_fixtures_provider (provider, provider_fixture_id),
  KEY idx_football_fixtures_kickoff (status, kickoff_at),
  KEY idx_football_fixtures_competition (competition_id, kickoff_at),
  CONSTRAINT fk_fixtures_competition FOREIGN KEY (competition_id) REFERENCES football_competitions(id),
  CONSTRAINT fk_fixtures_home FOREIGN KEY (home_team_id) REFERENCES football_teams(id),
  CONSTRAINT fk_fixtures_away FOREIGN KEY (away_team_id) REFERENCES football_teams(id)
) ENGINE=InnoDB;

CREATE TABLE football_events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fixture_id INT UNSIGNED NOT NULL,
  minute SMALLINT UNSIGNED NULL,
  type ENUM('GOAL','YELLOW_CARD','RED_CARD','SUBSTITUTION','OTHER') NOT NULL,
  team ENUM('HOME','AWAY') NOT NULL,
  player_name VARCHAR(100) NULL,
  detail VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_football_events_fixture (fixture_id, minute),
  CONSTRAINT fk_events_fixture FOREIGN KEY (fixture_id) REFERENCES football_fixtures(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Football challenge types: each row is a self-contained settlement
-- definition. The engine never hard-codes "how a question is judged" outside
-- of what's declared here + its resolver (src/football/settlementRules.js) —
-- `requires_stats` is what lets a data-poor provider safely disable a
-- question rather than guess.
-- ---------------------------------------------------------------------------
CREATE TABLE football_challenge_types (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(40) NOT NULL,
  name VARCHAR(80) NOT NULL,
  question_template VARCHAR(160) NOT NULL,
  pick_type ENUM('TEAM','YES_NO') NOT NULL,
  requires_stats TINYINT(1) NOT NULL DEFAULT 0,
  no_winner_rule ENUM('DRAW','VOID') NOT NULL,
  settlement_summary VARCHAR(255) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_challenge_types_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE football_challenges (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id INT UNSIGNED NOT NULL,
  fixture_id INT UNSIGNED NOT NULL,
  challenge_type_id INT UNSIGNED NOT NULL,
  creator_pick ENUM('HOME','AWAY','YES','NO') NOT NULL,
  opponent_pick ENUM('HOME','AWAY','YES','NO') NULL,
  cutoff_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_challenges_match (match_id),
  KEY idx_football_challenges_fixture (fixture_id, challenge_type_id),
  CONSTRAINT fk_fc_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_fc_fixture FOREIGN KEY (fixture_id) REFERENCES football_fixtures(id),
  CONSTRAINT fk_fc_type FOREIGN KEY (challenge_type_id) REFERENCES football_challenge_types(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Forward-compatibility only (see README "Path to real money"): these
-- columns/tables are NOT enforced by any business logic yet. They exist so a
-- future real-money rollout can add age/KYC verification and responsible-
-- gaming limits without another destructive migration. Real money stays
-- disabled regardless of these values.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN date_of_birth DATE NULL AFTER phone,
  ADD COLUMN kyc_status ENUM('NOT_REQUIRED','PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'NOT_REQUIRED' AFTER date_of_birth;

CREATE TABLE player_limits (
  user_id INT UNSIGNED PRIMARY KEY,
  daily_deposit_limit DECIMAL(12,2) NULL,
  daily_entry_limit DECIMAL(12,2) NULL,
  self_exclude_until DATE NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_player_limits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
