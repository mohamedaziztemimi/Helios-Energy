"""
PDF generation tool. Produces a real PDF file using reportlab — not mocked,
not a placeholder. The agent passes a title, free-text content, and
optionally tabular data; this tool handles the actual document layout so
the agent doesn't need to know reportlab's API.
"""

import os
import re
import uuid

from langchain_core.tools import tool
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle


def _safe_filename(title: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", title.strip()).strip("_").lower()
    return f"{slug or 'report'}_{uuid.uuid4().hex[:8]}.pdf"


def make_generate_pdf_tool(output_dir: str):
    """
    output_dir: the directory this run's generated files should be written
    to, e.g. /tmp/agent_outputs/<run_id>/. Passed in per-run so files from
    different users/runs never collide or overwrite each other.
    """

    @tool
    def generate_pdf(title: str, content: str, table_data: list[list[str]] | None = None) -> str:
        """
        Generate a real, downloadable PDF report. Returns the file path.

        title: the report's title, also used as the heading.
        content: the body text, in plain paragraphs (use \\n\\n between paragraphs).
        table_data: optional. A list of rows, where the first row is the
            header. Example: [["Plant", "Energy (kWh)"], ["Plant C1-001", "1234.5"]]
        """
        os.makedirs(output_dir, exist_ok=True)
        filename = _safe_filename(title)
        filepath = os.path.join(output_dir, filename)

        doc = SimpleDocTemplate(filepath, pagesize=letter)
        styles = getSampleStyleSheet()
        elements = [Paragraph(title, styles["Title"]), Spacer(1, 16)]

        for paragraph in content.split("\n\n"):
            if paragraph.strip():
                elements.append(Paragraph(paragraph.strip(), styles["Normal"]))
                elements.append(Spacer(1, 10))

        if table_data:
            elements.append(Spacer(1, 10))
            table = Table(table_data)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3A5F")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F4F7")]),
            ]))
            elements.append(table)

        doc.build(elements)
        return filepath

    return generate_pdf