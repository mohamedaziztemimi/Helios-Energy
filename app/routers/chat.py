"""
Chat endpoints. POST /api/chat starts an agent run in the background and
returns immediately with a run_id; the actual work happens in
_execute_agent_run, which streams the agent's steps into the agent_runs
table as they happen. The separate streaming endpoint (app/routers/stream.py)
reads from that table to show real-time progress — this is what satisfies
both the "real-time rendering" and "background runs survive a refresh"
requirements with one mechanism.

Every agent run is built with build_agent(db_session, ...) where db_session
is a connection scoped to the CALLING USER's company/access_scope/identity
(see app/db/session.get_scoped_connection) — this is what makes the agent's
SQL tool isolated, regardless of what the agent is asked to do.
"""

import os
import uuid

from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel

from app.config import settings
from app.routers.auth import get_current_user
from app.db.session import get_scoped_connection
from app.agent.graph import build_agent

router = APIRouter()


class ChatRequest(BaseModel):
    session_id: str | None = None  # if omitted, a new chat session is created
    message: str


@router.post("/api/chat")
def start_chat(
    body: ChatRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """
    Starts an agent run in the background and returns immediately with a
    run_id. The caller should connect to GET /api/runs/{run_id}/stream to
    watch it progress, or poll GET /api/runs/{run_id} for the current state.
    """
    run_id = str(uuid.uuid4())

    with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
        with conn.cursor() as cur:
            session_id = body.session_id
            if session_id is None:
                cur.execute(
                    "INSERT INTO chat_sessions (user_id, title) VALUES (%s, %s) RETURNING id",
                    (user["id"], body.message[:60]),
                )
                session_id = str(cur.fetchone()[0])

            cur.execute(
                "INSERT INTO agent_runs (id, session_id, user_id, status, input) "
                "VALUES (%s, %s, %s, 'running', %s)",
                (run_id, session_id, user["id"], body.message),
            )
        conn.commit()

    background_tasks.add_task(
        _execute_agent_run,
        run_id=run_id,
        message=body.message,
        company_id=user["company_id"],
        access_scope=user["access_scope"],
        user_id=user["id"],
    )

    return {"run_id": run_id, "session_id": session_id}


def _execute_agent_run(run_id: str, message: str, company_id: str, access_scope: str, user_id: str):
    """
    Runs in the background, outside the original HTTP request. Opens its
    OWN scoped connection (background tasks must not reuse a connection
    from a request that has already returned) and streams the agent's
    steps, appending to agent_runs.output as they happen.
    """
    output_dir = os.path.join(settings.OUTPUT_DIR, run_id)

    try:
        with get_scoped_connection(company_id, access_scope, user_id) as conn:
            agent = build_agent(conn, output_dir)

            accumulated_output = ""
            for chunk in agent.stream(
                {"messages": [{"role": "user", "content": message}]},
                stream_mode="updates",
            ):
                accumulated_output += _summarize_chunk(chunk) + "\n"
                _update_run(conn, run_id, status="running", output=accumulated_output)

            _update_run(conn, run_id, status="completed", output=accumulated_output)

    except Exception as e:
        with get_scoped_connection(company_id, access_scope, user_id) as conn:
            _update_run(conn, run_id, status="failed", output=None, error=str(e))


def _summarize_chunk(chunk: dict) -> str:
    """Turns one streamed graph step into a short human-readable line."""
    parts = []
    for node_name, node_output in chunk.items():
        parts.append(f"[{node_name}] {str(node_output)[:300]}")
    return "\n".join(parts)


def _update_run(conn, run_id: str, status: str, output: str | None, error: str | None = None):
    with conn.cursor() as cur:
        if output is not None:
            cur.execute(
                "UPDATE agent_runs SET status = %s, output = %s, updated_at = now() WHERE id = %s",
                (status, output, run_id),
            )
        else:
            cur.execute(
                "UPDATE agent_runs SET status = %s, error = %s, updated_at = now() WHERE id = %s",
                (status, error, run_id),
            )
    conn.commit()


@router.get("/api/runs/{run_id}")
def get_run(run_id: str, user: dict = Depends(get_current_user)):
    """
    Polling fallback / initial state fetch. The RLS policy on agent_runs
    (user_id = current session's user) means a user can only ever fetch
    their OWN runs.
    """
    with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, status, input, output, error, created_at, updated_at "
                "FROM agent_runs WHERE id = %s",
                (run_id,),
            )
            row = cur.fetchone()

    if row is None:
        return {"error": "Run not found."}, 404

    return {
        "id": row[0], "status": row[1], "input": row[2],
        "output": row[3], "error": row[4],
        "created_at": row[5].isoformat(), "updated_at": row[6].isoformat(),
    }