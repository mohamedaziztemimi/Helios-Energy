# Multi-tenant agent over plant data

A web app where users from two different solar energy companies chat with an AI agent (GPT-5, via LangChain Deep Agents) about their plant operations and financial data. Built for the Invertix take-home assignment.

**Live app:** `https://take-home-assignment-production.up.railway.app`
**Demo access key:** shared separately with the Invertix contact, not committed to this repo.

## What this is

- FastAPI backend, PostgreSQL database with Row Level Security, a LangChain Deep Agent with 5 tools (SQL query, Python code execution, PDF/Word/Excel generation)
- Two companies, two roles each (admin: energy+financial access, operator: energy-only access)
- Real-time agent progress shown in the UI via Server-Sent Events with a polling fallback
- Background agent runs that survive a page refresh or closed browser tab
- Tenant and role isolation enforced at the PostgreSQL layer, not in application code or the agent's prompt

## Architecture

### Data model

The source data describes a hierarchy: a company owns plants, each plant has physical components (**Elements** — meters, weather stations, inverter groups), each Element reports one or more metrics (**Datasources**), and each Datasource produces timestamped readings (**Datapoints**). Financial data is two separate concerns: hourly market prices (company-wide, tied to a pricing zone, not a specific plant) and monthly operating costs (plant-specific, broken into categories like maintenance, insurance, land lease).

Every entity that exists in the source data uses the **source system's own ID** as its primary key directly (e.g. `"company_1"`, plant ID `1001`) rather than a generated UUID. Every source JSON/CSV file already references entities by these exact IDs, so reusing them avoids an unnecessary translation layer during ingestion. Entities that don't exist in the source data — chat sessions, agent runs, generated documents — use generated UUIDs, since there's no natural key to inherit.

### Isolation: PostgreSQL Row Level Security, not application code

This was the assignment's core requirement: *"isolation must be enforced at the data and infrastructure layer, not the prompt layer."*

Every tenant-scoped table has RLS enabled with a policy that filters every query — regardless of how it was written — down to rows matching the active database session's company:

```sql
ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
CREATE POLICY plants_company_isolation ON plants
    USING (company_id = current_setting('app.current_company_id', true));
```

Before running any query on a user's behalf, the backend opens a connection and sets three session variables on it (`app.current_company_id`, `app.current_access_scope`, `app.current_user_id`) using `SELECT set_config(...)` — a function call that accepts normal parameterized values, rather than a `SET` statement built from string interpolation, which would reopen exactly the kind of injection risk this design is meant to close.

The agent's SQL tool (`run_sql`) enforces only one thing itself: that the query is a read-only `SELECT`. It contains **no company-filtering logic of its own** — that would put the isolation guarantee back at the application layer. The tool trusts the database connection it's given, because the database is the only place that can enforce this correctly regardless of what SQL the agent generates, including a query with no `WHERE` clause at all.

**Two non-obvious things discovered and fixed during development, both verified live:**

1. PostgreSQL exempts the **table owner** from its own RLS policies by default — `FORCE ROW LEVEL SECURITY` is required to close that gap.
2. PostgreSQL **superusers** bypass RLS entirely, regardless of `FORCE`. Railway's default Postgres user is a superuser. The application connects through a separately created, deliberately non-superuser role (`app_user`, `GRANT SELECT/INSERT/UPDATE/DELETE` only) — the actual fix, confirmed by testing the same query as both roles and observing different (correct vs. leaking) results.

Role-based access (energy vs. energy+financial) uses the same mechanism — financial tables additionally require the session's `access_scope` to equal `'energy+financial'`.

An automated test suite (`tests/test_isolation.py`, 11 tests) proves these guarantees programmatically: company isolation including the deepest join chain (`datapoints → datasources → elements → plants`), role-based financial access, and fail-safe behavior when no session variables are set (returns zero rows, not an error and not all rows).

### Agent

Built with `deepagents` (LangChain Deep Agents, built on LangGraph) and GPT-5. Five tools:

| Tool | Purpose |
|---|---|
| `run_sql` | Read-only SQL against the RLS-protected connection |
| `run_python` | Sandboxed Python execution for analysis (pandas, calculations) |
| `generate_pdf` | Real PDF reports via `reportlab` |
| `generate_word` | Real `.docx` reports via `python-docx` |
| `generate_excel` | Real `.xlsx` workbooks via `openpyxl` |

`run_python` executes in a separate OS subprocess (`sys.executable -I`, isolated mode) with a stripped environment (the subprocess cannot read `DATABASE_URL`, `LLM_API_KEY`, or any other app secret), a fixed timeout, and a confined scratch directory. This is process-level isolation, not container-level — see Limitations below.

The agent was observed, repeatedly, recovering from its own mistakes mid-run: rejected non-`SELECT` queries, wrong column-name guesses, a missing type cast — in each case it read the error, adjusted, and continued, without the run failing. A real bug was found and fixed during this testing: a failed query left the PostgreSQL connection in an aborted-transaction state, silently breaking every later query in the same multi-step run, until a missing `conn.rollback()` was added to the SQL tool's error handler.

### Background runs and real-time rendering

Every agent run is a row in `agent_runs` (status, accumulated trace output, the extracted final answer, timestamps). The backend launches the actual agent execution in a **detached background thread** rather than FastAPI's built-in `BackgroundTasks` — `BackgroundTasks` execute within the same ASGI request/response scope and were observed terminating early if the originating browser tab was closed, which defeats the "runs continue even if you navigate away" requirement. A plain Python thread has no relationship to the HTTP request once started.

A `GET /api/runs/{run_id}/stream` endpoint (Server-Sent Events) polls that row server-side and pushes an update to the browser whenever the status or output changes, with a `GET /api/runs/{run_id}` polling endpoint as a fallback (the browser's native `EventSource` API can't set the `Authorization` header, so the streaming endpoint identifies the user via a query parameter instead — a narrower, deliberate exception to the header-based auth used everywhere else). If the browser refreshes or reconnects, it's simply re-reading the same database row — there's no in-memory state tied to a specific connection.

### Document generation

PDF, Word, and Excel files are real, generated on disk under `/tmp/agent_outputs/<run_id>/`, and downloadable via `GET /api/runs/{run_id}/files/{filename}` — which re-validates that the requesting user actually owns that `run_id` through the same RLS-scoped lookup used everywhere else, rather than trusting the run_id in the URL alone.

## Tenancy and demo access

Four seeded users (two companies × admin/operator) are selectable from a simple login screen — there is no password system. This is a deliberate scope decision: the assignment's actual focus is tenancy and role-based data isolation, which is fully real and enforced at the database layer regardless of how minimal the login screen is. A production version would add real authentication (hashed passwords, sessions/JWTs, likely SSO).

The deployed app is additionally gated by a single shared access key (an `X-Demo-Key` header, collected via a key-entry screen in the UI), checked before any route executes — this exists purely so a stranger who finds the public URL can't run up real GPT-5 API costs on the assignment's key. It is not a substitute for real auth and isn't intended to be one.

## Known limitations and what I'd do next

- **Code execution sandboxing** is process-level (separate subprocess, stripped env, timeout, confined directory), not container/microVM-level. With more time this would move to a per-execution container or a dedicated sandboxed runner service with no network egress and a read-only filesystem outside the scratch volume.
- **Background execution** uses a plain detached thread, which works correctly for a single server instance but wouldn't survive a server restart or load-balance across multiple instances. A real task queue (Celery, RQ) is the production version of the same idea.
- **RLS policies on `elements`/`datasources`/`datapoints`** rely on a join chain back to `plants` rather than a denormalized `company_id` column on each table, since none exists in the source data shape. Fine at this dataset's volume (~30k rows); would warrant denormalizing for performance at real scale.
- **No CI pipeline**, given the 1-day scope. The isolation test suite (`tests/test_isolation.py`) is the artifact that would run in one.
- **Role granularity** is currently a single boolean-like split (`energy` vs. `energy+financial`). A more general permission system would support finer-grained scopes if requirements grew.

## Project structure

```
app/
  main.py                 FastAPI entrypoint, middleware, static frontend serving
  config.py                Settings (env vars)
  db/
    session.py              Per-request RLS-scoped connections
    migrations/001_schema.sql   Schema + RLS policies (see comments for the
                                 FORCE RLS / non-superuser role discoveries)
  routers/
    auth.py                  User lookup, the Authorization header dependency
    chat.py                  Starts agent runs, background execution, history
    stream.py                 SSE streaming endpoint
    documents.py               File download endpoint
  agent/graph.py             Agent definition (deepagents + 5 tools)
  tools/                     run_sql, run_python, generate_pdf/word/excel
data_ingestion/ingest.py   Reads data/ (source JSON/CSV), populates the DB
frontend/index.html        Single-page UI
tests/test_isolation.py    11 automated isolation/role tests
```

## Running locally

```bash
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt

# .env: DATABASE_URL, LLM_API_KEY, DEMO_ACCESS_KEY (see app/config.py)
psql $DATABASE_URL -f app/db/migrations/001_schema.sql
python data_ingestion/ingest.py

uvicorn app.main:app --reload
# open http://127.0.0.1:8000
```

```bash
pytest tests/test_isolation.py -v
```
