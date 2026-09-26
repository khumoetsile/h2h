-- Allow the app user to create/use the test database too.
CREATE DATABASE IF NOT EXISTS rivalis_test;
GRANT ALL PRIVILEGES ON rivalis_test.* TO 'rivalis'@'%';
FLUSH PRIVILEGES;
