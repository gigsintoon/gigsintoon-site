-- Creates a limited database login for the website's API.
-- Run in Query editor. Replace the password with your own strong one first,
-- and store it only in the Static Web App's environment variables.
CREATE USER gigsweb WITH PASSWORD = 'CHANGE-ME-to-a-long-random-password';
GRANT SELECT, INSERT, UPDATE ON SCHEMA::music TO gigsweb;
-- (no DELETE and no table changes – the site can read and update, but not drop anything)
SELECT name, type_desc FROM sys.database_principals WHERE name = 'gigsweb';
