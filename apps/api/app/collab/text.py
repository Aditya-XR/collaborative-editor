import re
from typing import Any

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

# Where Tiptap's Collaboration extension keeps the document: an XML tree of ProseMirror nodes
# (paragraph, heading, bulletList > listItem > paragraph …) whose leaves hold formatted text.
EDITOR_ROOT = "default"

# Generous for a document, and keeps the search vector well under Postgres's 1 MB limit.
MAX_SEARCH_TEXT = 100_000

# Postgres text cannot hold NUL, and the search highlighter uses \x02 and \x03 as markers, so
# control characters other than newline and tab never reach the search column.
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def plain_text(doc: Doc[Any]) -> str:
    """The document's text without formatting, one line per block, for full-text search."""
    lines: list[str] = []

    def walk(node: XmlFragment | XmlElement) -> None:
        for child in node.children:
            if isinstance(child, XmlText):
                # diff() yields (content, formatting) runs; str() would include the formatting
                # as markup such as <bold>.
                lines.append("".join(run for run, _ in child.diff() if isinstance(run, str)))
            else:
                walk(child)

    walk(doc.get(EDITOR_ROOT, type=XmlFragment))
    text = "\n".join(line for line in lines if line)
    return _CONTROL.sub(" ", text)[:MAX_SEARCH_TEXT]
