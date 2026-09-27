-- A player who voluntarily leaves an already-LOCKED (MATCHED) football
-- challenge is charged a small, flat, clearly-disclosed abandonment fee —
-- separate from and in addition to the existing stake-refund/cancellation
-- rules, which are otherwise unchanged (both players still get their full
-- stake back, platform fee still zero). This is never charged for a
-- temporary disconnect — only an explicit, confirmed Leave action.
ALTER TABLE transactions MODIFY COLUMN type ENUM('DEPOSIT','WITHDRAWAL','GAME_ENTRY','GAME_WIN','REFUND','FORFEIT','ABANDONMENT_FEE') NOT NULL;
