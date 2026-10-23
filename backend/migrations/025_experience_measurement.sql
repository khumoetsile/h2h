-- Optional first-party UX measurement. No IP, user agent, token or free text.
CREATE TABLE experience_events (
  event_id CHAR(36) PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  visit_id CHAR(36) NOT NULL,
  event_name VARCHAR(32) NOT NULL,
  surface VARCHAR(24) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_experience_time_user (created_at, user_id),
  INDEX idx_experience_user_time (user_id, created_at),
  CONSTRAINT fk_experience_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
