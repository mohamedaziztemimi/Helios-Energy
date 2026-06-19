
"""
FastAPI application entrypoint. Wires together auth, chat, and streaming
routers. Run with:
    uvicorn app.main:app --reload          (local dev)
    uvicorn app.main:app --host 0.0.0.0 --port $PORT   (Railway/production)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import auth, chat

app = FastAPI(title="Invertix Plant Data Agent")

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


@app.get("/health")
def health():
    """Used by Railway (and you) to confirm the app is up."""
    return {"status": "ok"}