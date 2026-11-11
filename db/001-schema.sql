--
-- Gigs in toon - database schema v1
-- Azure SQL Database: gigsintoon (server gigsintoon-sql)
-- Run once in the portal: database > Query editor > paste > Run
-- (written without GO separators, which Query editor doesn't support)
-- Everything lives in its own "music" schema.
--

EXEC('CREATE SCHEMA music');

-- Bands / artists
CREATE TABLE music.Bands (
    BandId            INT IDENTITY(1,1) PRIMARY KEY,
    Name              NVARCHAR(200) NOT NULL,
    SortName          NVARCHAR(200) NULL,          -- e.g. "Darkness, The" for A-Z lists
    XHandle           NVARCHAR(100) NULL,          -- e.g. @TheDarkness
    InstagramHandle   NVARCHAR(100) NULL,          -- e.g. @thedarkness (NULL = use hashtag)
    BlueskyHandle     NVARCHAR(150) NULL,          -- e.g. @electrasy.online
    Hashtag           NVARCHAR(100) NULL,          -- fallback, e.g. #CatherineWheel
    NeverPost         BIT NOT NULL DEFAULT 0,      -- e.g. Anti-Flag, Lostprophets
    Notes             NVARCHAR(MAX) NULL,
    CreatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Bands_Name UNIQUE (Name)
);

-- Releases (one row per release; replaces the spreadsheet rows)
CREATE TABLE music.Releases (
    ReleaseId         INT IDENTITY(1,1) PRIMARY KEY,
    BandId            INT NOT NULL REFERENCES music.Bands(BandId),
    ArtistDisplay     NVARCHAR(300) NULL,          -- override for collaborations, e.g. "Lightning Seeds/Skinner/Baddiel"
    Title             NVARCHAR(400) NOT NULL,
    ReleaseType       NVARCHAR(20) NOT NULL DEFAULT 'Album'
                      CHECK (ReleaseType IN ('Album','Single','EP','Compilation','Live','Reissue','Other')),
    ReleaseDate       DATE NOT NULL,               -- UK release date
    ReleaseMonth      AS MONTH(ReleaseDate) PERSISTED,
    ReleaseDay        AS DAY(ReleaseDate) PERSISTED,
    ReleaseYear       AS YEAR(ReleaseDate) PERSISTED,
    DateNote          NVARCHAR(300) NULL,          -- e.g. "UK date; US 21st", "date uncertain"
    ChartPosition     INT NULL,                    -- UK chart peak, NULL if none
    ChartNote         NVARCHAR(200) NULL,          -- e.g. "reissue", "Japan only"
    Label             NVARCHAR(200) NULL,
    WriteUp           NVARCHAR(MAX) NULL,          -- the post text from the .txt file
    TagNotes          NVARCHAR(500) NULL,          -- the "tag @..." column from the spreadsheet
    Status            NVARCHAR(20) NOT NULL DEFAULT 'NotPosted'
                      CHECK (Status IN ('NotPosted','Drafted','Posted','DoNotPost')),
                      -- spreadsheet colours: none = NotPosted, orange = Drafted,
                      -- green = Posted (+ on Sonos), red = DoNotPost
    OnSonosPlaylist   BIT NOT NULL DEFAULT 0,
    Owned             BIT NOT NULL DEFAULT 0,      -- ticked = in my collection
    CreatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Releases_OnThisDay ON music.Releases (ReleaseMonth, ReleaseDay, ReleaseYear);
CREATE INDEX IX_Releases_Band      ON music.Releases (BandId);
CREATE INDEX IX_Releases_Year      ON music.Releases (ReleaseYear);

-- Venues
CREATE TABLE music.Venues (
    VenueId           INT IDENTITY(1,1) PRIMARY KEY,
    Name              NVARCHAR(200) NOT NULL,      -- e.g. "O2 Academy Newcastle"
    FormerNames       NVARCHAR(400) NULL,          -- e.g. "Carling Academy Newcastle"
    City              NVARCHAR(100) NULL,
    Hashtag           NVARCHAR(100) NULL,          -- e.g. #o2AcademyNewcastle
    CONSTRAINT UQ_Venues_Name UNIQUE (Name)
);

-- Gigs (gig memories)
CREATE TABLE music.Gigs (
    GigId             INT IDENTITY(1,1) PRIMARY KEY,
    GigDate           DATE NOT NULL,
    GigMonth          AS MONTH(GigDate) PERSISTED,
    GigDay            AS DAY(GigDate) PERSISTED,
    VenueId           INT NULL REFERENCES music.Venues(VenueId),
    VenueAsBilled     NVARCHAR(200) NULL,          -- venue name as it was then, e.g. "Telewest Arena"
    TourName          NVARCHAR(200) NULL,          -- e.g. "Wolves tour", "Inner City Sumo Tour"
    WriteUp           NVARCHAR(MAX) NULL,
    Status            NVARCHAR(20) NOT NULL DEFAULT 'NotPosted'
                      CHECK (Status IN ('NotPosted','Drafted','Posted','DoNotPost')),
    CreatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Gigs_OnThisDay ON music.Gigs (GigMonth, GigDay);

-- Bands on a gig bill (headliner + supports)
CREATE TABLE music.GigBands (
    GigId             INT NOT NULL REFERENCES music.Gigs(GigId) ON DELETE CASCADE,
    BandId            INT NOT NULL REFERENCES music.Bands(BandId),
    Billing           NVARCHAR(20) NOT NULL DEFAULT 'Headliner'
                      CHECK (Billing IN ('Headliner','Co-headliner','Support','Special guest')),
    BillOrder         INT NOT NULL DEFAULT 1,
    PRIMARY KEY (GigId, BandId)
);

-- Images (covers, CD1/CD2, ticket photos)
CREATE TABLE music.Images (
    ImageId           INT IDENTITY(1,1) PRIMARY KEY,
    ReleaseId         INT NULL REFERENCES music.Releases(ReleaseId) ON DELETE CASCADE,
    GigId             INT NULL REFERENCES music.Gigs(GigId) ON DELETE CASCADE,
    Kind              NVARCHAR(20) NOT NULL DEFAULT 'Cover'
                      CHECK (Kind IN ('Cover','CD1','CD2','CD3','Back','Ticket','Photo','Other')),
    BlobPath          NVARCHAR(400) NOT NULL,      -- path in Azure Blob Storage
    PublicUrl         NVARCHAR(600) NULL,          -- permanent link (used for Buffer posts)
    AltText           NVARCHAR(300) NULL,
    Source            NVARCHAR(50) NULL,           -- Apple Music, Discogs, Wikipedia, Own photo...
    Width             INT NULL,
    Height            INT NULL,
    SortOrder         INT NOT NULL DEFAULT 1,
    CreatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Images_Owner CHECK (
        (ReleaseId IS NOT NULL AND GigId IS NULL) OR (ReleaseId IS NULL AND GigId IS NOT NULL))
);
CREATE INDEX IX_Images_Release ON music.Images (ReleaseId);
CREATE INDEX IX_Images_Gig     ON music.Images (GigId);

-- Social posts log (what was drafted/scheduled in Buffer)
CREATE TABLE music.SocialPosts (
    SocialPostId      INT IDENTITY(1,1) PRIMARY KEY,
    ReleaseId         INT NULL REFERENCES music.Releases(ReleaseId) ON DELETE SET NULL,
    GigId             INT NULL REFERENCES music.Gigs(GigId) ON DELETE SET NULL,
    Channel           NVARCHAR(20) NOT NULL CHECK (Channel IN ('X','Instagram','Bluesky')),
    BufferPostId      NVARCHAR(40) NULL,
    PostText          NVARCHAR(MAX) NULL,
    ScheduledFor      DATETIME2(0) NULL,           -- UK time
    Status            NVARCHAR(20) NOT NULL DEFAULT 'Draft'
                      CHECK (Status IN ('Draft','Scheduled','Sent','Error','Deleted')),
    CreatedAt         DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_SocialPosts_Release ON music.SocialPosts (ReleaseId);

-- Handy view: "on this day" list for the website
EXEC('CREATE VIEW music.vOnThisDay AS
SELECT  r.ReleaseId, r.ReleaseMonth, r.ReleaseDay, r.ReleaseYear,
        COALESCE(r.ArtistDisplay, b.Name) AS Artist,
        r.Title, r.ReleaseType, r.ChartPosition, r.ChartNote, r.Label,
        r.WriteUp, r.Status, r.Owned, b.BandId, b.NeverPost
FROM    music.Releases r
JOIN    music.Bands b ON b.BandId = r.BandId');

-- Quick check - should list 7 tables and the vOnThisDay view (8 rows)
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'music' ORDER BY TABLE_NAME;
