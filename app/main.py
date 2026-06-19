
"""
FastAPI application entrypoint. Wires together auth, chat, and streaming
routers. Run with:
    uvicorn app.main:app --reload          (local dev)
    uvicorn app.main:app --host 0.0.0.0 --port $PORT   (Railway/production)
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.config import settings
from app.routers import auth, chat, stream
from app.routers import auth, chat, stream, documents
app = FastAPI(title="Invertix Plant Data Agent")


@app.middleware("http")
async def demo_access_key_gate(request: Request, call_next):
    """
    Lightweight shared-secret gate on /api/*. The frontend's splash screen
    collects a key, sends it as the X-Demo-Key header on every fetch, and
    falls back to a ?demo_key= query param on the SSE stream (the browser's
    native EventSource can't set custom headers). Empty DEMO_ACCESS_KEY
    disables the gate.
    """
    expected = settings.DEMO_ACCESS_KEY
    if expected and request.url.path.startswith("/api/") and request.method != "OPTIONS":
        provided = request.headers.get("X-Demo-Key") or request.query_params.get("demo_key")
        if provided != expected:
            return JSONResponse({"detail": "Invalid or missing access key."}, status_code=403)
    return await call_next(request)

# Permissive CORS for this take-home demo: the frontend is a single static
# page that may be served from a different origin than the API during local
# development. A production app would restrict this to the known frontend
# origin(s) rather than "*".
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(stream.router)

app.include_router(documents.router)
@app.get("/health")
def health():
    """Used by Railway (and me) to confirm the app is up."""
    return {"status": "ok"}