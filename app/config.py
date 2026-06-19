# Application configuration (pydantic-settings) — implementation pending.
"""
Central app configuration. Reads from environment variables / .env file once,
so the rest of the app imports `settings` instead of calling os.environ
everywhere.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database — must point to the non-superuser app_user role, never the
    # default superuser. See app/db/migrations/001_schema.sql for why.
    DATABASE_URL: str

    # LLM
    LLM_API_KEY: str
    LLM_BASE_URL: str | None = None  # set only if the assignment key needs a custom endpoint
    AGENT_MODEL: str = "gpt-5"

    # Where generated documents (PDF/Word/Excel) are written before download
    OUTPUT_DIR: str = "/tmp/agent_outputs"

    # Shared "demo access key" gating /api/* — set in .env. Empty disables
    # the gate (handy for local hacking without the splash screen).
    DEMO_ACCESS_KEY: str = ""


settings = Settings()