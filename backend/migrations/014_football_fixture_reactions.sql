CREATE TABLE football_fixture_reactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fixture_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  reaction ENUM('FIRE','SHOCK','GOAL') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_football_fixture_reaction_user (fixture_id, user_id),
  KEY idx_football_fixture_reactions_count (fixture_id, reaction),
  CONSTRAINT fk_football_reactions_fixture FOREIGN KEY (fixture_id) REFERENCES football_fixtures(id) ON DELETE CASCADE,
  CONSTRAINT fk_football_reactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
