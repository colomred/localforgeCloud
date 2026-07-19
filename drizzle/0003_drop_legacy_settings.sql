-- Purge settings keys that no longer exist: the pi-era Playwright toggles
-- and the engine migration flag. Forge is the only execution core.
DELETE FROM `settings` WHERE `key` IN ('playwright_enabled', 'playwright_headed', 'engine');
