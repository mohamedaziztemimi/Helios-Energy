"""
The agent itself, built with LangChain Deep Agents (deepagents package, built
on LangGraph). This module exposes ONE function, `build_agent(db_session)`,
which returns a ready-to-run agent scoped to a specific request's database
connection — meaning every tool call this agent makes is already constrained
by the Row Level Security policies attached to that connection's session
variables (see app/db/session.py).

The agent never receives the user's company_id or access_scope directly as
text it could be talked out of respecting — it only ever touches the
database through `db_session`, which has already had its session variables
set before this agent is built. That's the actual enforcement boundary:
even a fully "jailbroken" agent cannot query data its db_session can't see.
"""

from deepagents import create_deep_agent
from langchain_openai import ChatOpenAI

from app.config import settings
from app.tools.sql_tool import make_run_sql_tool
from app.tools.python_tool import run_python
from app.tools.pdf_tool import make_generate_pdf_tool
from app.tools.word_tool import make_generate_word_tool
from app.tools.excel_tool import make_generate_excel_tool


SYSTEM_PROMPT = """You are an analyst assistant for a solar plant operations company.

You can query the company's plant data (energy production, plant metadata) and,
depending on the active user's access level, financial data (market prices,
operating costs). You do not need to filter results by company yourself —
every query you run is automatically scoped to the active user's company by
the database itself. If you try to query another company's data, you will
simply get zero rows back; this is expected and not an error to work around.

If the active user's access level does not include financial data, financial
tables will return zero rows for you. Do not attempt to infer or estimate
financial figures from energy data alone if asked for ungranted financial
data — explain that this information isn't available with the user's current
access level.

You can:
- Query data with run_sql (read-only SQL against the plant database)
- Run Python for analysis with run_python (pandas, calculations, simple charts)
- Generate downloadable PDF, Word, or Excel reports when asked

Always ground your answers in actual query results. Do not fabricate numbers.
"""


def build_agent(db_session, output_dir: str):
    """
    db_session: an open database connection/session whose RLS session
                variables (app.current_company_id, app.current_access_scope,
                app.current_user_id) have ALREADY been set by the caller,
                per request, before this function is called.
    output_dir: where this run's generated documents should be written,
                e.g. /tmp/agent_outputs/<run_id>/
    """
    model = ChatOpenAI(
        model=settings.AGENT_MODEL,       # "gpt-5"
        api_key=settings.LLM_API_KEY,
        base_url=settings.LLM_BASE_URL,   # set if the assignment key uses a custom endpoint
        streaming=True,
    )

    tools = [
        make_run_sql_tool(db_session),
        run_python,
        make_generate_pdf_tool(output_dir),
        make_generate_word_tool(output_dir),
        make_generate_excel_tool(output_dir),
    ]

    agent = create_deep_agent(
        model=model,
        tools=tools,
        system_prompt=SYSTEM_PROMPT,
    )
    return agent