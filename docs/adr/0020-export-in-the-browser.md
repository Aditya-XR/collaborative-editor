# 0020 · Export to Markdown, Word and PDF, in the browser

- **Status:** accepted
- **Date:** 2026-10-29

## Context

People want a document out of the app: Markdown for a README or a wiki, Word to send to someone,
PDF to print or attach. The server holds the Yjs state, not a rendered document, so exporting
there would mean a second renderer to keep in step with the editor's schema. It would also stop
export from working offline (ADR 0019).

## Decision

**All three are built in the browser from the editor's own JSON** (`editor.getJSON()`), so each
export matches what is on screen and works without a connection.

**Markdown: a hand-written converter** (`features/export/markdown.ts`, about 250 lines).

- **What it covers:** the document has a dozen node types: headings, paragraphs, lists and
  checklists, quotes, code blocks, rules, images, tables and line breaks. Each has a rule a reader
  can check.
- **Output:** GitHub-flavoured Markdown, so checklists and tables survive.
- **Marks:** marks shared by neighbouring text stay open (`**a *b***`, not `**a****b**`), and
  spaces move outside the delimiters, where Markdown requires them.
- **Escaping:** characters that would start formatting are escaped, as is a paragraph that starts
  like a heading or a list.
- **Fences:** code is fenced with more backticks than it contains.
- **Underline:** it has no Markdown form, so it becomes `<u>`, which GitHub renders.

**Word: the `docx` library, loaded on demand** (`features/export/docx.ts`).

- **Why a library:** a .docx is a zip of OOXML parts with relationships and numbering
  definitions. Writing that by hand would be most of the work and none of the value. The mapping
  from our nodes to Word's is ours.
- **Mapping:**
  - Headings become Word heading styles, so the navigation pane works.
  - Bullet and numbered lists become real Word lists. Each numbered list keeps its own start and
    renumbers when edited.
  - Checklists become ☐ and ☒.
  - Tables become tables, with the header row repeating across pages.
- **Images:** fetched by address and scaled to the page width. One that cannot be fetched (offline,
  or a host without CORS) or that Word cannot show (WebP, SVG) becomes a link to its address
  instead.
- **Loading:** the library is about 130 kB gzipped, so its chunk loads only when someone picks
  Word. It is precached, so it works offline too.

**PDF: the browser's print dialog with a print stylesheet.** This gives selectable, searchable text
with the browser's own fonts and pagination. A rendered picture of the page would give none of
that, and a JavaScript PDF library would add a second layout engine.

- **Shown:** the title and the text only, on white even in dark mode.
- **Hidden:** the header, toolbar, buttons, comments, cursors and highlights.
- **Pagination:** headings, table rows and images are kept from splitting across pages.
- **File name:** the page title is the document's title, so "Save as PDF" suggests it.

## Consequences

- Exports contain the text, not its comments or history.
- Images in a Word file depend on their hosts allowing cross-origin reads. Otherwise they appear
  as links, which says where the image was.
- The print layout follows the browser's print settings. Margins are set to 2 cm, but the person
  can change paper size and headers.
- The Markdown converter and the Word builder have unit tests on hand-built documents. The Word
  tests unzip the output and read its XML.
