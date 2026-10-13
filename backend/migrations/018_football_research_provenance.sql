-- Read-only research provenance; settlement continues using existing scores.
ALTER TABLE football_fixtures
  ADD COLUMN research_eligible TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN score_duration VARCHAR(24) NULL;
