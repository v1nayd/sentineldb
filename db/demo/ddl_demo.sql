-- DDL demonstration: CREATE, ALTER (add / modify / rename column, add / drop CHECK), CREATE / DROP INDEX,
-- CREATE / DROP VIEW, RENAME TABLE, TRUNCATE, DROP TABLE.
-- Run: npm run db:ddl-demo            (prints every statement and its effect; leaves the schema exactly as it found it)
-- Uses only objects prefixed demo_ and references the real IOCs table read-only through a foreign key.
-- Format: "-- step:" starts a step; "-- expect-error: <errno>" marks a statement that MUST fail (constraint demo).

-- step: CREATE TABLE with a primary key, a foreign key to IOCs and a NOT NULL column
CREATE TABLE demo_watchlist (
    watch_id  INT AUTO_INCREMENT PRIMARY KEY,
    ioc_id    INT NOT NULL,
    note      VARCHAR(100),
    CONSTRAINT fk_demo_watchlist_ioc FOREIGN KEY (ioc_id) REFERENCES IOCs(ioc_id) ON DELETE RESTRICT
) ENGINE=InnoDB;
SHOW CREATE TABLE demo_watchlist;

-- step: ALTER TABLE ... ADD COLUMN with a default, then ADD CONSTRAINT ... CHECK
ALTER TABLE demo_watchlist ADD COLUMN priority TINYINT NOT NULL DEFAULT 3;
ALTER TABLE demo_watchlist ADD CONSTRAINT chk_demo_priority CHECK (priority BETWEEN 1 AND 5);

-- step: the CHECK is enforced: priority 9 is rejected with error 3819
INSERT INTO demo_watchlist (ioc_id, note, priority) SELECT MIN(ioc_id), 'valid row', 2 FROM IOCs;
-- expect-error: 3819
INSERT INTO demo_watchlist (ioc_id, note, priority) SELECT MIN(ioc_id), 'invalid priority', 9 FROM IOCs;
SELECT watch_id, ioc_id, note, priority FROM demo_watchlist;

-- step: ALTER TABLE ... MODIFY COLUMN (widen) and RENAME COLUMN
ALTER TABLE demo_watchlist MODIFY COLUMN note VARCHAR(255);
ALTER TABLE demo_watchlist RENAME COLUMN note TO reason;

-- step: CREATE INDEX and confirm the optimizer can use it
CREATE INDEX idx_demo_priority ON demo_watchlist (priority);
EXPLAIN SELECT watch_id FROM demo_watchlist WHERE priority = 2;

-- step: RENAME TABLE, then CREATE VIEW over it (joined to IOCs)
RENAME TABLE demo_watchlist TO demo_ioc_watchlist;
CREATE VIEW demo_watchlist_view AS
  SELECT w.watch_id, c.ioc_type, c.ioc_value, w.priority, w.reason
  FROM demo_ioc_watchlist w JOIN IOCs c ON c.ioc_id = w.ioc_id;
SELECT * FROM demo_watchlist_view;

-- step: TRUNCATE removes all rows but keeps the table definition
TRUNCATE TABLE demo_ioc_watchlist;
SELECT COUNT(*) AS rows_after_truncate FROM demo_ioc_watchlist;

-- step: DROP VIEW, DROP INDEX, ALTER TABLE ... DROP CHECK, DROP COLUMN
DROP VIEW demo_watchlist_view;
DROP INDEX idx_demo_priority ON demo_ioc_watchlist;
ALTER TABLE demo_ioc_watchlist DROP CHECK chk_demo_priority;
ALTER TABLE demo_ioc_watchlist DROP COLUMN priority;
SHOW CREATE TABLE demo_ioc_watchlist;

-- step: DROP TABLE, and DROP ... IF EXISTS is idempotent
DROP TABLE demo_ioc_watchlist;
DROP TABLE IF EXISTS demo_ioc_watchlist;

-- step: the catalog shows nothing left behind
SELECT COUNT(*) AS demo_objects_left FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'demo\_%';
