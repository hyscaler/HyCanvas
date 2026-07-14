-- Regional preferences on the user profile: timezone, clock (time) format, and
-- first day of week. Additive and defaulted so every existing row is unchanged;
-- '' (timezone) and 'auto' (time_format, week_start) mean "follow the browser
-- and locale" at render time, which is exactly how pre-existing users behaved.
ALTER TABLE "users" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN "time_format" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "users" ADD COLUMN "week_start" TEXT NOT NULL DEFAULT 'auto';
