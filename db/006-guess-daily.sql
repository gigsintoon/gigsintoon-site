-- Gigs in toon: Guess the cover goes daily (from 15 Nov 2026).
-- Each day's mystery cover is saved here so it stays the same all day and is never repeated.
-- Run once in the Azure portal: SQL database > Query editor, signed in as the admin login. Safe to run more than once.
IF OBJECT_ID('music.GuessPicks') IS NULL
CREATE TABLE music.GuessPicks (
    Period    NVARCHAR(10) NOT NULL CONSTRAINT PK_GuessPicks PRIMARY KEY,   -- UK date, e.g. 2026-11-15
    ReleaseId INT          NOT NULL,
    PickedAt  DATETIME2    NOT NULL CONSTRAINT DF_GuessPicks_PickedAt DEFAULT SYSUTCDATETIME()
);
SELECT 'GuessPicks ready' AS Done, COUNT(*) AS Picks FROM music.GuessPicks;
