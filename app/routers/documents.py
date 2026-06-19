"""
Serves generated documents (PDF/Word/Excel) for download. Files live on
disk at OUTPUT_DIR/<run_id>/<filename>, written by the document-generation
tools (app/tools/pdf_tool.py etc.) during an agent run.

ACCESS CONTROL: this endpoint does not just trust the run_id in the URL —
a user could otherwise guess or share another user's run_id and download
their files. Instead, it looks up the run_id in agent_runs through the
SAME scoped connection used everywhere else, so RLS enforces that a user
can only ever resolve run_ids that belong to them. If the run isn't theirs,
the lookup returns nothing and we 404, exactly as if it didn't exist.
"""

import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.routers.auth import get_current_user
from app.db.session import get_scoped_connection
from app.config import settings

router = APIRouter()


@router.get("/api/runs/{run_id}/files/{filename}")
def download_file(run_id: str, filename: str, user: dict = Depends(get_current_user)):
    with get_scoped_connection(user["company_id"], user["access_scope"], user["id"]) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM agent_runs WHERE id = %s", (run_id,))
            row = cur.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    safe_filename = os.path.basename(filename)
    filepath = os.path.join(settings.OUTPUT_DIR, run_id, safe_filename)

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="File not found.")

    return FileResponse(filepath, filename=safe_filename)