-- Gigs in toon: move the data that was kept in files (blob storage) into the database.
-- Run once in the Azure portal: SQL database > Query editor, signed in as the admin login.
-- Safe to run more than once.

-- Messages from the contact form (with the 30-day bin)
IF OBJECT_ID('music.Messages') IS NULL
CREATE TABLE music.Messages (
    MessageId   NVARCHAR(40)   NOT NULL PRIMARY KEY,
    ReceivedAt  DATETIME2(0)   NOT NULL,
    Name        NVARCHAR(100)  NULL,
    Email       NVARCHAR(200)  NULL,
    Topic       NVARCHAR(50)   NULL,
    Body        NVARCHAR(4000) NOT NULL,
    IsRead      BIT            NOT NULL DEFAULT 0,
    DeletedAt   DATETIME2(0)   NULL
);

-- Admin to-do list
IF OBJECT_ID('music.Todos') IS NULL
CREATE TABLE music.Todos (
    TodoId     NVARCHAR(16)   NOT NULL PRIMARY KEY,
    Title      NVARCHAR(300)  NOT NULL,
    Detail     NVARCHAR(3000) NULL,
    Owner      NVARCHAR(10)   NOT NULL,
    Done       BIT            NOT NULL DEFAULT 0,
    Answer     NVARCHAR(3000) NULL,
    CreatedAt  DATETIME2(0)   NOT NULL,
    DoneAt     DATETIME2(0)   NULL
);

-- Releases added through the website form, waiting to be copied into the spreadsheet
IF OBJECT_ID('music.SiteAdditions') IS NULL
CREATE TABLE music.SiteAdditions (
    AdditionId INT IDENTITY(1,1) PRIMARY KEY,
    ReleaseId  INT            NULL,
    Entry      NVARCHAR(MAX)  NOT NULL,   -- the form as sent (JSON)
    AddedAt    DATETIME2(0)   NOT NULL
);

-- Colour (status) changes made on the site that aren't in the spreadsheet yet
IF OBJECT_ID('music.StatusOverrides') IS NULL
CREATE TABLE music.StatusOverrides (
    ReleaseId   INT            NOT NULL PRIMARY KEY,
    Band        NVARCHAR(200)  NOT NULL,
    Title       NVARCHAR(400)  NOT NULL,
    ReleaseDate DATE           NOT NULL,
    Colour      NVARCHAR(10)   NOT NULL,
    Status      NVARCHAR(20)   NOT NULL,
    OnSonos     BIT            NOT NULL,
    ChangedAt   DATETIME2(0)   NOT NULL
);

-- Setlists and playlist links on gigs
IF COL_LENGTH('music.Gigs', 'SetlistJson') IS NULL ALTER TABLE music.Gigs ADD SetlistJson NVARCHAR(MAX) NULL;
IF COL_LENGTH('music.Gigs', 'SetlistUrl')  IS NULL ALTER TABLE music.Gigs ADD SetlistUrl  NVARCHAR(400) NULL;
IF COL_LENGTH('music.Gigs', 'PlaylistUrl') IS NULL ALTER TABLE music.Gigs ADD PlaylistUrl NVARCHAR(400) NULL;

-- Guess the cover: weekly tally and leaderboard
IF OBJECT_ID('music.GuessWeeks') IS NULL
CREATE TABLE music.GuessWeeks (
    Week     NVARCHAR(10) NOT NULL PRIMARY KEY,
    Tries    INT          NOT NULL DEFAULT 0,
    Correct  INT          NOT NULL DEFAULT 0
);
IF OBJECT_ID('music.GuessScores') IS NULL
CREATE TABLE music.GuessScores (
    ScoreId    NVARCHAR(20) NOT NULL PRIMARY KEY,
    Week       NVARCHAR(10) NOT NULL,
    Name       NVARCHAR(24) NOT NULL,
    Guesses    INT          NOT NULL,
    Ms         INT          NOT NULL,
    CreatedAt  DATETIME2(0) NOT NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GuessScores_Week')
CREATE INDEX IX_GuessScores_Week ON music.GuessScores (Week, Guesses, Ms);

-- Remembering cards (musicians who died on a day)
IF OBJECT_ID('music.Remembering') IS NULL
CREATE TABLE music.Remembering (
    RememberId  INT IDENTITY(1,1) PRIMARY KEY,
    DeathMonth  TINYINT        NOT NULL,
    DeathDay    TINYINT        NOT NULL,
    Name        NVARCHAR(100)  NOT NULL,
    DeathYear   INT            NULL,
    Age         INT            NULL,
    Note        NVARCHAR(300)  NULL,
    Bands       NVARCHAR(800)  NULL      -- JSON list of band names to link to
);

-- Favourite albums by year
IF OBJECT_ID('music.FavouriteYears') IS NULL
CREATE TABLE music.FavouriteYears (
    Year    INT           NOT NULL PRIMARY KEY,
    Title   NVARCHAR(200) NOT NULL,
    Note    NVARCHAR(500) NULL,
    Kind    NVARCHAR(20)  NULL,          -- 'upcoming' for next year's announced releases
    Ranked  BIT           NOT NULL DEFAULT 0
);
IF OBJECT_ID('music.FavouriteAlbums') IS NULL
CREATE TABLE music.FavouriteAlbums (
    FavouriteId INT IDENTITY(1,1) PRIMARY KEY,
    Year        INT            NOT NULL,
    SortOrder   INT            NOT NULL,
    Rank        INT            NULL,
    Artist      NVARCHAR(200)  NOT NULL,
    Title       NVARCHAR(400)  NOT NULL,
    Note        NVARCHAR(1000) NULL,
    CoverUrl    NVARCHAR(800)  NULL
);

-- Site settings (e.g. the weekly email key, stored only as a hash)
IF OBJECT_ID('music.Settings') IS NULL
CREATE TABLE music.Settings (
    Name       NVARCHAR(50)  NOT NULL PRIMARY KEY,
    Value      NVARCHAR(MAX) NULL,
    UpdatedAt  DATETIME2(0)  NOT NULL
);

-- Lets the Settings page show how big the database is
GRANT VIEW DATABASE STATE TO gigsweb;
