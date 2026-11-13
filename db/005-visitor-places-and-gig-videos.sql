-- Gigs in toon: visitor locations (by time zone) and YouTube videos on gig pages.
-- Run once in the Azure portal: SQL database > Query editor, signed in as the admin login. Safe to run more than once.
IF OBJECT_ID('music.PageViewPlaces') IS NULL
CREATE TABLE music.PageViewPlaces (
    ViewDate DATE         NOT NULL,
    Place    NVARCHAR(60) NOT NULL,   -- the visitor's time zone, e.g. Europe/London
    Views    INT          NOT NULL DEFAULT 0,
    CONSTRAINT PK_PageViewPlaces PRIMARY KEY (ViewDate, Place)
);
IF COL_LENGTH('music.Gigs', 'VideoJson') IS NULL ALTER TABLE music.Gigs ADD VideoJson NVARCHAR(MAX) NULL;  -- [{"id":"youtube id","title":"..."}]
