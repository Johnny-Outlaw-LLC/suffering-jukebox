-- Give the second fixed-password ShutterField smoke-test user a Listening
-- Party profile too. Authentication and the shared password remain owned by
-- ShutterField; this migration never creates or changes credentials.

select jukebox.ensure_test_account('testing2@shutterfield.com', 'Johnny D Two');
