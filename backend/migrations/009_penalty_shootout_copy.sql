-- The penalty shootout is now played live against another player (take turns shooting and keeping
-- goal), so the player-facing copy changes with it. Applies to existing databases; the seed carries the same text.
UPDATE games SET
  tagline = 'Take turns shooting and keeping goal.',
  description = 'A live penalty shootout against another player. Five kicks each, one at a time. When you shoot, your opponent dives. When they shoot, you dive.',
  how_to_play = 'Every kick, you both choose in secret. Shooting: pick a corner, then stop the timing bar in the green. High corners need a tight stop and low shots are more forgiving, and a perfect strike at a high corner cannot be saved. Keeping goal: pick the side you think they will shoot at. Five kicks each, then sudden death if it is level.',
  estimated_duration_seconds = 120
WHERE slug = 'penalty-shootout'
