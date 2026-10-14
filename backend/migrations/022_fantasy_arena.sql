CREATE TABLE fantasy_arenas (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(100) NOT NULL, description VARCHAR(500) NULL,
 status ENUM('DRAFT','OPEN','LOCKED','LIVE','SETTLING','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
 entry_cents INT UNSIGNED NOT NULL, fee_bps SMALLINT UNSIGNED NOT NULL DEFAULT 1000,
 first_bps SMALLINT UNSIGNED NOT NULL DEFAULT 5000, second_bps SMALLINT UNSIGNED NOT NULL DEFAULT 3000, third_bps SMALLINT UNSIGNED NOT NULL DEFAULT 2000,
 deadline DATETIME NULL, published_at DATETIME NULL, locked_at DATETIME NULL, completed_at DATETIME NULL,
 participant_count INT UNSIGNED NOT NULL DEFAULT 0,
 gross_cents BIGINT UNSIGNED NOT NULL DEFAULT 0, fee_cents BIGINT UNSIGNED NOT NULL DEFAULT 0, net_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
 first_cents BIGINT UNSIGNED NOT NULL DEFAULT 0, second_cents BIGINT UNSIGNED NOT NULL DEFAULT 0, third_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
 cancellation_reason VARCHAR(255) NULL, created_by INT UNSIGNED NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(created_by) REFERENCES users(id), KEY idx_arena_status_deadline(status,deadline),
 CHECK(first_bps+second_bps+third_bps=10000), CHECK(fee_bps<=10000)
) ENGINE=InnoDB;
CREATE TABLE fantasy_arena_fixtures (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, arena_id INT UNSIGNED NOT NULL, fixture_id INT UNSIGNED NOT NULL,
 position SMALLINT UNSIGNED NOT NULL, reference_team_id INT UNSIGNED NOT NULL,
 home_team_id INT UNSIGNED NOT NULL, away_team_id INT UNSIGNED NOT NULL,
 scheduled_kickoff DATETIME NOT NULL, resolution_deadline DATETIME NOT NULL,
 actual_result ENUM('WIN','DRAW','LOSS','VOID') NULL, resolved_at DATETIME NULL, resolution_reason VARCHAR(150) NULL,
 UNIQUE KEY uq_arena_fixture(arena_id,fixture_id), UNIQUE KEY uq_arena_position(arena_id,position),
 FOREIGN KEY(arena_id) REFERENCES fantasy_arenas(id), FOREIGN KEY(fixture_id) REFERENCES football_fixtures(id),
 FOREIGN KEY(reference_team_id) REFERENCES football_teams(id)
) ENGINE=InnoDB;
CREATE TABLE fantasy_arena_entries (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, arena_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
 points SMALLINT UNSIGNED NOT NULL DEFAULT 0, incorrect SMALLINT UNSIGNED NOT NULL DEFAULT 0, remaining SMALLINT UNSIGNED NOT NULL DEFAULT 0,
 final_rank INT UNSIGNED NULL, payout_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
 joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_arena_entry(arena_id,user_id), KEY idx_arena_ranking(arena_id,points,id), KEY idx_arena_user(user_id,arena_id),
 FOREIGN KEY(arena_id) REFERENCES fantasy_arenas(id), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE fantasy_arena_predictions (
 entry_id BIGINT UNSIGNED NOT NULL, arena_fixture_id INT UNSIGNED NOT NULL,
 pick ENUM('WIN','DRAW','LOSS') NOT NULL, PRIMARY KEY(entry_id,arena_fixture_id),
 FOREIGN KEY(entry_id) REFERENCES fantasy_arena_entries(id), FOREIGN KEY(arena_fixture_id) REFERENCES fantasy_arena_fixtures(id)
) ENGINE=InnoDB;
CREATE TABLE fantasy_arena_settlements (
 arena_id INT UNSIGNED PRIMARY KEY, kind ENUM('PAYOUT','REFUND') NOT NULL,
 gross_cents BIGINT UNSIGNED NOT NULL, fee_cents BIGINT UNSIGNED NOT NULL, paid_cents BIGINT UNSIGNED NOT NULL,
 audit JSON NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(arena_id) REFERENCES fantasy_arenas(id)
) ENGINE=InnoDB;
ALTER TABLE transactions MODIFY COLUMN type ENUM('DEPOSIT','WITHDRAWAL','GAME_ENTRY','GAME_WIN','REFUND','FORFEIT','ABANDONMENT_FEE','ARENA_ENTRY','ARENA_REWARD','ARENA_FORFEIT','ARENA_REFUND') NOT NULL;
ALTER TABLE transactions ADD COLUMN arena_id INT UNSIGNED NULL, ADD KEY idx_tx_arena(arena_id), ADD FOREIGN KEY(arena_id) REFERENCES fantasy_arenas(id);
