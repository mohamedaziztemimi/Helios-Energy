"""
Per-request database session management.

This is the bridge between "who is logged in" and "what Postgres will let
them see." Every connection returned by `get_scoped_connection` has its RLS
session variables already set via set_config() — so any query run on that
connection (including the agent's run_sql tool) is automatically filtered
by the Row Level Security policies in app/db/migrations/001_schema.sql.

IMPORTANT: this module always connects using settings.DATABASE_URL, which
must point at the non-superuser app_user role (see migration file notes —
PostgreSQL superusers bypass RLS entirely regardless of policy). Never use
a superuser connection string here.

Session variables are set with SELECT set_config(name, value, false) rather
than a SET statement built from string formatting. set_config() is a normal
SQL function call, so it accepts standard parameter substitution — avoiding
ever interpolating a value directly into SQL text, even though company_id
and access_scope come from our own trusted database lookup rather than raw
user input.
"""

from contextlib import contextmanager

import psycopg2

from app.config import settings


def _raw_connection():
    return psycopg2.connect(settings.DATABASE_URL)


@contextmanager
def get_scoped_connection(company_id: str, access_scope: str, user_id: str):
    """
    Yields a psycopg2 connection scoped to the given user's company, access
    scope, and identity. Use this for ANY query path that should respect
    tenant isolation — which is every path except the privileged ingestion
    script (data_ingestion/ingest.py), which intentionally connects
    differently because it has no single logged-in user.
    """
    conn = _raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config(%s, %s, false)", ("app.current_company_id", company_id))
            cur.execute("SELECT set_config(%s, %s, false)", ("app.current_access_scope", access_scope))
            cur.execute("SELECT set_config(%s, %s, false)", ("app.current_user_id", user_id))
        conn.commit()  # session variables persist for the life of this connection
        yield conn
    finally:
        conn.close()


def get_auth_connection():
    """
    A connection with NO RLS session variables set, used only by the auth
    lookup itself (app/routers/auth.py) to read the companies/users tables
    and determine which company_id/access_scope/user_id to scope future
    queries to. Those two tables are not RLS-protected (see migration file
    notes) — but this connection is never handed to the agent or used for
    any tenant-scoped table, only for the initial "who is this user" lookup.
    """
    return _raw_connection()