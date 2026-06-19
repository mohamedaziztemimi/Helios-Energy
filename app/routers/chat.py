"""
Chat endpoints. POST /api/chat starts an agent run in a genuinely detached
background thread and returns immediately with a run_id; the actual work
happens in _execute_agent_run, which streams the agent's steps into the
agent_runs table as they happen. The separate streaming endpoint
(app/routers/stream.py) reads from that table to show real-time progress —
this is what satisfies both the "real-time rendering" and "background runs
survive a refresh" requirements with one mechanism.

IMPORTANT: we deliberately do NOT use FastAPI's built-in BackgroundTasks
here. BackgroundTasks execute within the same request/response ASGI scope,
and in practice can be affected by client disconnects (e.g. closing the
browser tab) depending on server/middleware behavior — which defeats the
"runs continue even if you navigate away" requirement. Instead we launch a
plain Python thread that has no relationship to the HTTP request at all
once started; closing the browser tab cannot reach it. This is a deliberate
choice, not an oversight — see README for the tradeoff (a real task queue
like Celery/RQ would be the production-grade version of this same idea).

Every agent run is built with build_agent(db_session, ...) where db_session
is a connection scoped to the CALLING USER's company/access_scope/identity
(see app/db/session.get_scoped_connection) — this is what makes the agent's
SQL tool isolated, regardless of what the agent is asked to do.
"""

import os
import uuid
import threading

from fastapi import APIRouter, Depends
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
    user: dict = Depends(get_current_user),
):
    """
    Starts an agent run in a detached background thread and returns
    immediately with a run_id. The caller should connect to
    GET /api/runs/{run_id}/stream to watch it progress, or poll
    GET /api/runs/{run_id} for the current state.
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

    thread = threading.Thread(
        target=_execute_agent_run,
        kwargs=dict(
            run_id=run_id,
            message=body.message,
            company_id=user["company_id"],
            access_scope=user["access_scope"],
            user_id=user["id"],
        ),
        daemon=True,
    )
    thread.start()

    return {"run_id": run_id, "session_id": session_id}


def _execute_agent_run(run_id: str, message: str, company_id: str, access_scope: str, user_id: str):
    """
    Runs in a detached thread, outside the original HTTP request's
    lifecycle entirely. Opens its OWN scoped connection and streams the
    agent's steps, appending to agent_runs.output as they happen.
    """
    output_dir = os.path.join(settings.OUTPUT_DIR, run_id)

    try:
        with get_scoped_connection(company_id, access_scope, user_id) as conn:
            agent = build_agent(conn, output_dir)

            accumulated_output = ""
            final_text = ""
            for chunk in agent.stream(
                {"messages": [{"role": "user", "content": message}]},
                stream_mode="updates",
            ):
                accumulated_output += _summarize_chunk(chunk) + "\n"
                last_text = _extract_latest_ai_text(chunk)
                if last_text:
                    final_text = last_text
                _update_run(conn, run_id, status="running", output=accumulated_output, final_text=final_text)

            _update_run(conn, run_id, status="completed", output=accumulated_output, final_text=final_text)

    except Exception as e:
        with get_scoped_connection(company_id, access_scope, user_id) as conn:
            _update_run(conn, run_id, status="failed", output=None, error=str(e))


def _summarize_chunk(chunk: dict) -> str:
    """Turns one streamed graph step into a short human-readable line."""
    parts = []
    for node_name, node_output in chunk.items():
        parts.append(f"[{node_name}] {str(node_output)[:300]}")
    return "\n".join(parts)


def _extract_latest_ai_text(chunk: dict) -> str | None:
    """
    Pulls out the actual natural-language text of the latest AI message in
    this chunk, if any (as opposed to a tool call, which has empty content).
    This is what lets the frontend show a real chat bubble for the agent's
    answer or clarifying question, instead of only the technical trace.
    """
    for node_output in chunk.values():
        messages = node_output.get("messages") if isinstance(node_output, dict) else None
        if not messages:
            continue
        for msg in messages:
            content = getattr(msg, "content", None)
            if content and isinstance(content, str) and content.strip():
                return content
    return None


def _update_run(conn, run_id: str, status: str, output: str | None, error: str | None = None, final_text: str | None = None):
    with conn.cursor() as cur:
        if output is not None:
            cur.execute(
                "UPDATE agent_runs SET status = %s, output = %s, final_text = %s, updated_at = now() WHERE id = %s",
                (status, output, final_text, run_id),
            )
        else:
            cur.execute(
                "UPDATE agent_runs SET status = %s, error = %s, updated_at = now() WHERE id = %s",
                (status, error, run_id),
            )
    conn.commit()


@router.get("/api/runs")
def list_runs(user: dict = Depends(get_current_user)):
    """
    Lists the current user's past agent runs (most recent first), so the
    frontend can show conversation history after a fresh page load.
    """
    with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, session_id, status, input, output, final_text, created_at, updated_at "
                "FROM agent_runs ORDER BY created_at DESC LIMIT 50"
            )
            rows = cur.fetchall()

    return [
        {
            "id": r[0], "session_id": r[1], "status": r[2], "input": r[3],
            "output": r[4], "final_text": r[5],
            "created_at": r[6].isoformat(), "updated_at": r[7].isoformat(),
        }
        for r in rows
    ]


@router.get("/api/runs/{run_id}")
def get_run(run_id: str, user: dict = Depends(get_current_user)):
    """
    Polling fallback / initial state fetch. RLS-enforced per-user isolation.
    """
    with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, status, input, output, final_text, error, created_at, updated_at "
                "FROM agent_runs WHERE id = %s",
                (run_id,),
            )
            row = cur.fetchone()

    if row is None:
        return {"error": "Run not found."}, 404

    return {
        "id": row[0], "status": row[1], "input": row[2],
        "output": row[3], "final_text": row[4], "error": row[5],
        "created_at": row[6].isoformat(), "updated_at": row[7].isoformat(),
    }