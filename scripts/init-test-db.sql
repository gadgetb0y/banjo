-- Runs only on first initialisation of the Postgres data volume (Docker
-- executes /docker-entrypoint-initdb.d once, when the data directory is
-- empty). An existing install needs `docker compose down -v` to pick it up.
--
-- npm test's DB-backed suites hardcode postgresql://banjo:banjo@localhost:5432/banjo_test,
-- so the name here is load-bearing. Creating it up front removes the manual
-- createdb step the README used to require.
CREATE DATABASE banjo_test;
