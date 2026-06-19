"""
The agent's SQL tool. This is the most safety-critical file in the project.

Two independent layers of protection here, on purpose:

1. READ-ONLY ENFORCEMENT (this file): the tool rejects any query that isn't
   a SELECT, so the agent cannot INSERT/UPDATE/DELETE/DROP even if asked to.
   This is a basic guardrail at the tool layer.

2. TENANT ISOLATION (NOT this file — enforced by PostgreSQL itself via the
   Row Level Security policies in app/db/migrations/001_schema.sql, combined
   with the db_session passed in already having its session variables set).
   This tool does not, and must not, contain any company_id filtering logic
   itself. If it did, that would put the isolation guarantee back at the
   application/prompt layer, which is exactly what the assignment requires
   us to avoid. The tool trusts the database to do this job, because the
   database is the only place that can do it safely regardless of what SQL
   the agent generates.
"""

import re

from langchain_core.tools import tool


# Anything other than a SELECT is rejected outright. This is intentionally
# a simple, conservative check — false positives (rejecting a legitimate
# read) are an acceptable tradeoff for never allowing a write.
_DISALLOWED_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|EXEC|EXECUTE)\b",
    re.IGNORECASE,
)

# The agent's SQL tool must never be able to read the users table directly —
# this is a deliberate boundary separate from RLS (see migration file notes).
_FORBIDDEN_TABLES = re.compile(r"\busers\b", re.IGNORECASE)

MAX_ROWS = 1000


def make_run_sql_tool(db_session):
    """
    db_session: a psycopg2 connection/cursor whose RLS session variables
    (app.current_company_id, app.current_access_scope, app.current_user_id)
    have already been set by the request handler before the agent is built.
    This factory closes over that connection so the returned tool always
    queries through it — the agent itself never sees or controls which
    connection or company it's scoped to.
    """

    @tool
    def run_sql(query: str) -> str:
        """
        Execute a READ-ONLY SQL query against the plant database and return
        the results as text. Only SELECT statements are permitted. You do
        not need to filter by company_id — every query you run is already
        scoped to the active user's company by the database itself, and
        financial tables are automatically empty if the active user's role
        does not include financial access.

        Available tables: plants, elements, datasources, datapoints,
        hourly_market_prices, monthly_costs.

        Example: SELECT name, parameters FROM plants
        Example: SELECT p.name, AVG(dp.value) FROM datapoints dp
                 JOIN datasources ds ON ds.id = dp.datasource_id
                 JOIN elements e ON e.id = ds.element_id
                 JOIN plants p ON p.id = e.plant_id
                 GROUP BY p.name
        """
        stripped = query.strip().rstrip(";")

        if not stripped.upper().startswith("SELECT"):
            return "Error: only SELECT queries are allowed."

        if _DISALLOWED_KEYWORDS.search(stripped):
            return "Error: query contains a disallowed keyword. Only read-only SELECT queries are permitted."

        if _FORBIDDEN_TABLES.search(stripped):
            return "Error: the users table is not accessible through this tool."

        # Defense in depth: cap rows returned even though LIMIT isn't
        # required of the agent's query.
        limited_query = f"SELECT * FROM ({stripped}) AS subquery LIMIT {MAX_ROWS}"

        try:
            with db_session.cursor() as cur:
                cur.execute(limited_query)
                columns = [desc[0] for desc in cur.description] if cur.description else []
                rows = cur.fetchall()
        except Exception as e:
            return f"Query error: {e}"

        if not rows:
            return "Query returned no rows."

        header = " | ".join(columns)
        lines = [header, "-" * len(header)]
        for row in rows:
            lines.append(" | ".join(str(v) for v in row))

        return "\n".join(lines)

    return run_sql