"""
FastAPI application entrypoint. Wires together auth, chat, and streaming
routers, AND serves the frontend (frontend/index.html) as static content —
so the deployed Railway URL serves both the API and the UI from one place,
no separate frontend hosting needed.

Run with:
    uvicorn app.main:app --reload          (local dev)
    uvicorn app.main:app --host 0.0.0.0 --port $PORT   (Railway/production)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routers import auth, chat, stream, documents
from app.middleware import DemoAccessGateMiddleware

app = FastAPI(title="Invertix Plant Data Agent")

app.add_middleware(DemoAccessGateMiddleware)

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
    """Used by Railway (and you) to confirm the app is up."""
    return {"status": "ok"}


# Serves frontend/index.html and any other static assets at the root URL.
# Mounted LAST so it doesn't shadow the /api/* and /health routes above.
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")