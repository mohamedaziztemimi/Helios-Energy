"""
Server-Sent Events streaming endpoint. Satisfies the "render the agent's
reasoning, progress, and output in real time" requirement.

Design: this endpoint does NOT talk to the agent directly. It watches the
SAME agent_runs row that the background task (app/routers/chat.py) is
writing to, polling it on a short interval and pushing a new SSE event only
when something changed. This is deliberately simple — no pub/sub, no
message queue — and it composes naturally with the background-run
requirement: if the browser disconnects and reconnects (refresh), it just
opens a new stream against the same run_id and immediately sees the
current state, because the source of truth is the database row, not an
in-memory connection.

Note on EventSource and auth: the browser's native EventSource API cannot
set custom headers (no Authorization header support), so this endpoint
accepts the user identity as a query parameter instead, for this endpoint
only. This is a narrower exception, not a general pattern — every other
endpoint keeps using the Authorization header. RLS isolation is unaffected
either way, since the actual data access still goes through a connection
scoped by the looked-up user's company_id/access_scope.
"""

import asyncio
import json

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.db.session import get_auth_connection, get_scoped_connection

router = APIRouter()

POLL_INTERVAL_SECONDS = 1.0


def _lookup_user(user_id: str) -> dict | None:
    conn = get_auth_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, company_id, access_scope FROM users WHERE id = %s", (user_id,)
            )
            row = cur.fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {"id": row[0], "company_id": row[1], "access_scope": row[2]}


async def _event_generator(run_id: str, user: dict):
    """
    Polls the agent_runs row and yields an SSE event whenever status or
    output length changes. Stops once status is completed/failed, or after
    a safety cap on total polls (prevents an abandoned connection from
    polling forever if a run somehow never finishes).
    """
    last_output_len = -1
    last_status = None
    max_polls = 600  # ~10 minutes at 1s interval, generous safety cap

    for _ in range(max_polls):
        with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status, output, error FROM agent_runs WHERE id = %s", (run_id,)
                )
                row = cur.fetchone()

        if row is None:
            yield f"data: {json.dumps({'error': 'Run not found.'})}\n\n"
            return

        status, output, error = row

        if status != last_status or len(output or "") != last_output_len:
            payload = {"status": status, "output": output, "error": error}
            yield f"data: {json.dumps(payload)}\n\n"
            last_status = status
            last_output_len = len(output or "")

        if status in ("completed", "failed"):
            return

        await asyncio.sleep(POLL_INTERVAL_SECONDS)

    yield f"data: {json.dumps({'status': 'timeout', 'error': 'Stream polling timed out.'})}\n\n"


@router.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str, user_id: str = Query(...)):
    """
    GET /api/runs/{run_id}/stream?user_id=company_1_admin

    user_id is passed as a query param (not a header) because the browser's
    native EventSource API cannot set custom headers — see module docstring.
    """
    user = _lookup_user(user_id)
    if user is None:
        return StreamingResponse(
            iter([f"data: {json.dumps({'error': 'Unknown user.'})}\n\n"]),
            media_type="text/event-stream",
        )

    return StreamingResponse(
        _event_generator(run_id, user),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )