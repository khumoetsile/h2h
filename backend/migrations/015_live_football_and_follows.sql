ALTER TABLE football_fixtures
  ADD COLUMN match_phase VARCHAR(40) NULL AFTER minute,
  ADD COLUMN ball_coordinates JSON NULL AFTER stats_available;

ALTER TABLE football_events
  ADD COLUMN provider_event_id VARCHAR(80) NULL AFTER fixture_id,
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER minute,
  ADD UNIQUE KEY uq_football_events_provider_event (fixture_id, provider_event_id);

UPDATE admin_settings
SET setting_value = JSON_ARRAY_APPEND(setting_value, '$', 'SM172')
WHERE setting_key = 'football_supported_competitions'
  AND JSON_CONTAINS(setting_value, JSON_QUOTE('SM172')) = 0;

UPDATE admin_settings
SET setting_value = JSON_ARRAY_APPEND(setting_value, '$', 'SM501')
WHERE setting_key = 'football_supported_competitions'
  AND JSON_CONTAINS(setting_value, JSON_QUOTE('SM501')) = 0;

CREATE TABLE football_followed_fixtures (
  user_id INT UNSIGNED NOT NULL,
  fixture_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, fixture_id),
  KEY idx_football_followed_fixture (fixture_id),
  CONSTRAINT fk_football_followed_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_football_followed_fixture FOREIGN KEY (fixture_id) REFERENCES football_fixtures(id) ON DELETE CASCADE
) ENGINE=InnoDB;
