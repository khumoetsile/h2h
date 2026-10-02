-- What a player wants to be pinged about on their phone.
--  notify_challenges: a challenge for them, a friend joining their invite, a match about to start (on by default).
--  notify_waiting:    "someone is looking for a game". Off until they ask for it, and rate-limited.
ALTER TABLE users
  ADD COLUMN notify_challenges TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN notify_waiting TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN last_waiting_push_at DATETIME NULL;
