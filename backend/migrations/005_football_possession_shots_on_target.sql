-- Adds the two additional stat pairs needed for the "more possession" and
-- "more shots on target" football challenge types. NULL means "not known"
-- (same convention as the existing shots/corners/cards columns) and must
-- never be treated as 0 when settling a stats-based challenge.
ALTER TABLE football_fixtures
  ADD COLUMN home_possession TINYINT UNSIGNED NULL AFTER away_shots,
  ADD COLUMN away_possession TINYINT UNSIGNED NULL AFTER home_possession,
  ADD COLUMN home_shots_on_target TINYINT UNSIGNED NULL AFTER away_possession,
  ADD COLUMN away_shots_on_target TINYINT UNSIGNED NULL AFTER home_shots_on_target;
