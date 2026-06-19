"""
Authentication for this demo.

DELIBERATE SCOPE DECISION: this is not a real password/session auth system.
Users are selected from the seeded list (4 total: 2 companies x 2 roles
each) and identified by a simple bearer token that's just their user_id.
This is intentional, not an oversight — the assignment's actual focus is
tenancy and role-based data isolation, which is fully real and enforced at
the database layer regardless of how "real" the login screen is. A
production version would add real password hashing, sessions/JWTs, and
likely SSO; that tradeoff is called out in the README.

Every other route in this app reads the user_id from this header:
    Authorization: Bearer <user_id>
and uses it to look up that user's company_id and access_scope before
opening a properly RLS-scoped database connection (see app/db/session.py).
"""

from fastapi import APIRouter, Header, HTTPException

from app.db.session import get_auth_connection

router = APIRouter()


@router.get("/api/users")
def list_users():
    """Returns the seeded demo users, for the login screen's dropdown."""
    conn = get_auth_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, company_id, email, role, access_scope FROM users ORDER BY company_id, role"
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {"id": r[0], "company_id": r[1], "email": r[2], "role": r[3], "access_scope": r[4]}
        for r in rows
    ]


def get_current_user(authorization: str = Header(...)) -> dict:
    """
    FastAPI dependency used by every other protected route. Extracts the
    user_id from the Authorization header, looks up their company and
    access_scope, and returns them. Routes use this to build a properly
    scoped database connection — see app/db/session.get_scoped_connection.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")

    user_id = authorization.removeprefix("Bearer ").strip()

    conn = get_auth_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, company_id, email, role, access_scope FROM users WHERE id = %s",
                (user_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=401, detail="Unknown user.")

    return {
        "id": row[0],
        "company_id": row[1],
        "email": row[2],
        "role": row[3],
        "access_scope": row[4],
    }