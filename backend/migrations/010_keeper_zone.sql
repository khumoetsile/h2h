-- The keeper now dives to one of the same six zones the kicker shoots at (top/bottom x left/centre/right),
-- so a save needs the exact zone. Existing rows kept a column 0..2; treat them as the low zone of that column.
ALTER TABLE shootout_rounds CHANGE COLUMN keeper_col keeper_zone TINYINT UNSIGNED NULL;
UPDATE shootout_rounds SET keeper_zone = keeper_zone + 3 WHERE keeper_zone IS NOT NULL;
UPDATE games SET
  how_to_play = 'Every kick, you both choose in secret. Shooting: pick one of six spots, then stop the timing bar in the green. High spots need a tight stop and low shots are more forgiving, and a perfect strike at a high spot cannot be saved. Keeping goal: pick the spot you think they will shoot at. You only save it if you dive to the exact same spot, so high and low matter. Five kicks each, then sudden death if it is level.'
WHERE slug = 'penalty-shootout'
