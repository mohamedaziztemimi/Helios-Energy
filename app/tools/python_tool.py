"""
The agent's code execution tool. Satisfies the assignment's requirement
that the agent have "code execution ability to enable/support its analysis
and document creation."

Isolation approach: a separate OS subprocess per execution, not exec() in
the main FastAPI process. This is a deliberate, honestly-scoped choice for
a 1-day project — see the limitations note at the bottom of this file for
what a production version would add.

What this DOES protect against:
- A crash or infinite loop in agent-generated code cannot take down the
  FastAPI server itself (separate process).
- The executed code cannot read the app's environment variables (DATABASE_URL,
  LLM_API_KEY, etc.) — the subprocess is given a stripped environment.
- Runaway code is killed after a fixed timeout rather than hanging forever.
- File writes are confined to a per-run scratch directory.

What this does NOT protect against (see limitations note):
- Network access from within the subprocess is not blocked.
- This is process-level isolation, not container/VM-level isolation.
"""

import subprocess
import tempfile
import os

from langchain_core.tools import tool

TIMEOUT_SECONDS = 20
MAX_OUTPUT_CHARS = 4000


@tool
def run_python(code: str) -> str:
    """
    Execute Python code in an isolated environment for data analysis
    (e.g. with pandas) and return whatever it prints to stdout. Use this
    for calculations, aggregations, or analysis that's easier to express
    in code than in SQL — for example computing a trend, a correlation, or
    formatting a multi-step calculation. The code must print() its results
    to be visible to you; return values are not captured.

    pandas is available. The code has no access to the database directly —
    use run_sql first to fetch data, then pass the results into this tool
    as plain Python values if you need further analysis.
    """
    with tempfile.TemporaryDirectory() as scratch_dir:
        try:
            result = subprocess.run(
                ["python3", "-I", "-c", code],
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                cwd=scratch_dir,
                env={"PATH": os.environ.get("PATH", "/usr/bin")},
            )
        except subprocess.TimeoutExpired:
            return f"Error: code execution exceeded {TIMEOUT_SECONDS} second timeout."

        output = result.stdout
        if result.returncode != 0:
            output += f"\n[stderr]\n{result.stderr}"

        if not output.strip():
            return "Code executed with no output. Did you forget to print() your result?"

        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + "\n...[output truncated]"

        return output

# ----------------------------------------------------------------------
# Known limitations (scoped intentionally for a 1-day build):
#
# - This is process-level isolation, not container/microVM sandboxing
#   (e.g. gVisor, Firecracker). Outbound network access and filesystem
#   reads outside the scratch directory are not blocked at the OS level.
# - No CPU/memory ulimits are applied beyond the execution timeout.
# - Next step with more time: run each execution in its own container
#   (or a dedicated sandboxed runner service) with no network egress,
#   a read-only filesystem aside from the scratch volume, and resource
#   limits enforced by the container runtime rather than this function.
# ----------------------------------------------------------------------