-- Guest accounts: a player can start playing with no email or password and "save" the account later.
ALTER TABLE users ADD COLUMN is_guest TINYINT(1) NOT NULL DEFAULT 0 AFTER is_bot;
