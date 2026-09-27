-- Server-authoritative PvP timers. Every deadline a player can see is stamped
-- here, as an absolute timestamp, at the moment the state transition that
-- starts it happens — durations come from config.timers (env), never from
-- the client. Changing a duration later only affects timers started after
-- the change, never ones already running.
--
--   acceptance_deadline     WAITING: someone must join (Find Opponent) by then
--   lock_in_deadline        MATCHED: both players must press Lock In by then
--   locked_at               both players locked in (the challenge is LOCKED)
--   completion_deadline     skill game: finish by then; football: result must be verifiable by then
--   player_action_deadline  one player has acted; the other must act by then
--   end_reason              why an active challenge ended other than a normal result
--   abandoned_by            the player who explicitly left a LOCKED challenge (charged the fee)
ALTER TABLE matches
  ADD COLUMN acceptance_deadline DATETIME(3) NULL AFTER seed,
  ADD COLUMN lock_in_deadline DATETIME(3) NULL AFTER acceptance_deadline,
  ADD COLUMN locked_at DATETIME(3) NULL AFTER lock_in_deadline,
  ADD COLUMN completion_deadline DATETIME(3) NULL AFTER locked_at,
  ADD COLUMN player_action_deadline DATETIME(3) NULL AFTER completion_deadline,
  ADD COLUMN end_reason VARCHAR(24) NULL AFTER result_reason,
  ADD COLUMN abandoned_by INT UNSIGNED NULL AFTER end_reason,
  ADD CONSTRAINT fk_matches_abandoned_by FOREIGN KEY (abandoned_by) REFERENCES users(id);

-- Reconnection window: set when a player's last socket drops while they still
-- owe an action, cleared when they reconnect. A timeout that falls inside this
-- window waits for it to close before it is applied.
ALTER TABLE match_players
  ADD COLUMN disconnected_at DATETIME(3) NULL AFTER submitted_at,
  ADD COLUMN reconnect_deadline DATETIME(3) NULL AFTER disconnected_at;

-- Before this migration a football challenge counted as locked as soon as the
-- second player joined (MATCHED). Lock In is now an explicit step and LOCKED
-- is READY, so carry existing rows over as already locked in — they must not
-- suddenly become subject to a lock-in timer they never saw.
UPDATE match_players mp JOIN matches m ON m.id = mp.match_id
  SET mp.ready_at = COALESCE(mp.ready_at, m.matched_at, m.created_at)
  WHERE m.category = 'FOOTBALL' AND m.status = 'MATCHED';

UPDATE matches
  SET status = 'READY', ready_at = COALESCE(ready_at, matched_at, created_at), locked_at = COALESCE(matched_at, created_at)
  WHERE category = 'FOOTBALL' AND status = 'MATCHED';

-- The sweeper writes a heartbeat every tick. On boot, the gap since the last
-- heartbeat is how long the server was down; running timers are extended by
-- that gap so nobody is timed out for the platform's own outage.
CREATE TABLE system_heartbeats (
  name VARCHAR(40) PRIMARY KEY,
  beat_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
