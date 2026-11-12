-- Run once in the Azure portal: SQL database > Query editor, signed in as the admin login.
-- 1) Table for the cookie-free visitor counts shown on the admin page.
IF OBJECT_ID('music.PageViews') IS NULL
CREATE TABLE music.PageViews (
    ViewDate  DATE          NOT NULL,
    Path      NVARCHAR(200) NOT NULL,
    RefHost   NVARCHAR(200) NOT NULL,
    Device    NVARCHAR(10)  NOT NULL,
    Views     INT           NOT NULL DEFAULT 0,
    CONSTRAINT PK_PageViews PRIMARY KEY (ViewDate, Path, RefHost, Device)
);
-- 2) Let the site replace a gig's bill and photos when a gig is updated.
GRANT DELETE ON SCHEMA::music TO gigsweb;
