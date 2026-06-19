CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------- Core tenancy tables ----------

-- IDs below use the SOURCE DATA'S OWN IDs as primary keys directly
-- (e.g. "company_1") rather than generated UUIDs.
-- Every source file (JSON/CSV) references entities by these exact IDs,
-- so this avoids an unnecessary translation layer during ingestion.
-- UUIDs are only used below for NEW entities we create ourselves
-- (chat_sessions, agent_runs, generated_documents) that have no source ID.

CREATE TABLE companies (
    id    TEXT PRIMARY KEY,                    -- "company_1", "company_2" (source company_id)
    name  TEXT NOT NULL
);

CREATE TABLE users (
    id            TEXT PRIMARY KEY,             -- "company_1_admin" (source user_id)
    company_id    TEXT NOT NULL REFERENCES companies(id),
    email         TEXT UNIQUE NOT NULL,
    role          TEXT NOT NULL,                -- 'admin' | 'operator'
    access_scope  TEXT NOT NULL CHECK (access_scope IN ('energy', 'energy+financial')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Plant data ----------

CREATE TABLE plants (
    id          INT PRIMARY KEY,                -- 1001, 1002, ... (source plant Id)
    company_id  TEXT NOT NULL REFERENCES companies(id),
    name        TEXT NOT NULL,
    parameters  JSONB NOT NULL DEFAULT '{}'::jsonb  -- nominal power, region, commissioning date, etc.
);

CREATE TABLE elements (
    id           INT PRIMARY KEY,               -- source "Identifier"
    plant_id     INT NOT NULL REFERENCES plants(id),
    name         TEXT NOT NULL,
    type_string  TEXT NOT NULL
);

CREATE TABLE datasources (
    id                INT PRIMARY KEY,          -- source "DataSourceId"
    element_id        INT NOT NULL REFERENCES elements(id),
    name              TEXT NOT NULL,
    units             TEXT NOT NULL,
    aggregation_type  TEXT NOT NULL              -- 'sum' | 'average' (from request_manifest.json)
);

CREATE TABLE datapoints (
    id            BIGSERIAL PRIMARY KEY,
    datasource_id INT NOT NULL REFERENCES datasources(id),
    ts            TIMESTAMPTZ NOT NULL,
    value         DOUBLE PRECISION NOT NULL
);
CREATE INDEX idx_datapoints_ds_ts ON datapoints (datasource_id, ts);

-- ---------- Financial data ----------

CREATE TABLE hourly_market_prices (
    id            BIGSERIAL PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id),
    zone          TEXT NOT NULL,
    ts            TIMESTAMPTZ NOT NULL,
    eur_per_mwh   DOUBLE PRECISION NOT NULL
);
CREATE INDEX idx_prices_company_ts ON hourly_market_prices (company_id, ts);

CREATE TABLE monthly_costs (
    id          BIGSERIAL PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id),
    plant_id    INT NOT NULL REFERENCES plants(id),
    year        INT NOT NULL,
    month       INT NOT NULL,
    category    TEXT NOT NULL,
    amount_eur  DOUBLE PRECISION NOT NULL,
    notes       TEXT
);
CREATE INDEX idx_costs_plant ON monthly_costs (plant_id, year, month);

-- ---------- Agent / app state (per-user, not shared across tenants) ----------

CREATE TABLE chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL REFERENCES users(id),
    title       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES chat_sessions(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
    input       TEXT NOT NULL,
    output      TEXT NOT NULL DEFAULT '',
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE generated_documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID NOT NULL REFERENCES agent_runs(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    file_type   TEXT NOT NULL,    -- pdf | docx | xlsx
    file_path   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- These policies are the actual isolation enforcement.
-- They apply no matter what SQL the agent generates.
-- ============================================================

-- Session variables set per-request by the backend (see app/db/session.py):
--   app.current_company_id   -> text id of the logged-in user's company (e.g. "company_1")
--   app.current_access_scope -> 'energy' or 'energy+financial'
--   app.current_user_id      -> text id of the logged-in user (e.g. "company_1_admin")

ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
CREATE POLICY plants_company_isolation ON plants
    USING (company_id = current_setting('app.current_company_id', true));

ALTER TABLE elements ENABLE ROW LEVEL SECURITY;
CREATE POLICY elements_company_isolation ON elements
    USING (plant_id IN (
        SELECT id FROM plants WHERE company_id = current_setting('app.current_company_id', true)
    ));

ALTER TABLE datasources ENABLE ROW LEVEL SECURITY;
CREATE POLICY datasources_company_isolation ON datasources
    USING (element_id IN (
        SELECT e.id FROM elements e
        JOIN plants p ON p.id = e.plant_id
        WHERE p.company_id = current_setting('app.current_company_id', true)
    ));

ALTER TABLE datapoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY datapoints_company_isolation ON datapoints
    USING (datasource_id IN (
        SELECT ds.id FROM datasources ds
        JOIN elements e ON e.id = ds.element_id
        JOIN plants p ON p.id = e.plant_id
        WHERE p.company_id = current_setting('app.current_company_id', true)
    ));

-- Financial tables: company isolation AND role/access_scope check
ALTER TABLE hourly_market_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY prices_isolation ON hourly_market_prices
    USING (
        company_id = current_setting('app.current_company_id', true)
        AND current_setting('app.current_access_scope', true) = 'energy+financial'
    );

ALTER TABLE monthly_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY costs_isolation ON monthly_costs
    USING (
        company_id = current_setting('app.current_company_id', true)
        AND current_setting('app.current_access_scope', true) = 'energy+financial'
    );

-- Per-user isolation (not company-wide): chat history, agent runs, documents
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_user_isolation ON chat_sessions
    USING (user_id = current_setting('app.current_user_id', true));

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY runs_user_isolation ON agent_runs
    USING (user_id = current_setting('app.current_user_id', true));

ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_user_isolation ON generated_documents
    USING (user_id = current_setting('app.current_user_id', true));

-- NOTE: companies and users tables are intentionally NOT row-level-secured here.
-- They're only ever queried by the auth layer using a privileged connection
-- (e.g. "who is this user, what company are they in") to bootstrap the session
-- variables above. The agent's SQL tool should never have direct access to
-- the users table at all (enforce this at the tool layer, not just RLS).
-- ============================================================
-- FORCE RLS even for the table owner
-- ============================================================
-- By default, PostgreSQL exempts the TABLE OWNER from its own RLS policies.
-- Since this migration runs as the database's default/owner role, every
-- policy above would be silently bypassed for that role without this.
-- FORCE makes the owner subject to RLS too (still not a fix for superusers
-- — see note below).

ALTER TABLE plants FORCE ROW LEVEL SECURITY;
ALTER TABLE elements FORCE ROW LEVEL SECURITY;
ALTER TABLE datasources FORCE ROW LEVEL SECURITY;
ALTER TABLE datapoints FORCE ROW LEVEL SECURITY;
ALTER TABLE hourly_market_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE monthly_costs FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE generated_documents FORCE ROW LEVEL SECURITY;

-- ============================================================
-- REQUIRED: a non-superuser application role
-- ============================================================
-- PostgreSQL superusers bypass Row Level Security entirely, by design,
-- regardless of FORCE ROW LEVEL SECURITY. Managed Postgres providers
-- (Railway included) give you a superuser by default for administration.
-- That role must NEVER be used by the application itself, or every
-- isolation guarantee above is silently void.
--
-- Run this once per database (manually, or as a deploy step), then point
-- the app's DATABASE_URL at app_user, not the default superuser role.
-- Verified manually: connecting as the default superuser returned rows
-- from every company regardless of session variables; connecting as
-- app_user correctly returned only the active company's rows.

CREATE ROLE app_user WITH LOGIN PASSWORD 'CHANGE_ME_BEFORE_DEPLOY';
GRANT CONNECT ON DATABASE railway TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;