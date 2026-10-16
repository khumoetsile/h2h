ALTER TABLE fantasy_arenas ADD COLUMN automatic_key VARCHAR(50) NULL,
  ADD UNIQUE KEY uq_arena_automatic(automatic_key);
