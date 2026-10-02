# 0015 · Full-text search in Postgres

- **Status:** accepted
- **Date:** 2026-10-02

## Context

The dashboard needs search across titles and document text, as people type, limited to
documents they can open, on a $0 stack. Document text lives in Yjs updates the database cannot
read.

## Decision

- **Index plain text.** Whenever the server folds the edit log (compaction or a new version), it
  extracts the text from Tiptap's XML tree with pycrdt and stores it in `documents.search_text`.
- **Search with Postgres.** `search_tsv` is a stored generated column with a GIN index, titles
  weighted above bodies. No Elasticsearch: one less service to run, and the index stays in the
  same transaction as the data.
- **Match as people type.** Every word is indexed twice:
  - stemmed (`english`), so "runs" finds "running";
  - as written (`simple`), so the prefix "runn", typed so far, finds "running" too.
  Each typed word must match one of the two as a prefix.
- **Never build a query from raw input.** Words are split on tsquery syntax and control
  characters, quoted, and sent as bound parameters. A test sends `'`, `&`, `:*`, `<->`, NUL,
  emoji and `' OR 1=1 --` and expects results, never an error. NUL found a real 500 that way.
- **Highlights without HTML.** `ts_headline` marks matches with `\x02`/`\x03`, characters that
  never reach `search_text`. The API returns `[{text, match}]` parts, and the browser renders
  them as text, so a document's contents cannot inject markup.
- **Access first.** The query joins `document_members` for the caller, the same rule as every
  other endpoint, and skips trashed documents.

## Consequences

- Body text is searchable once its session ends or after 500 edits, not keystroke by keystroke.
  Titles are searchable at once.
- Documents written before this change become searchable after their next editing session.
- `english` stemming suits English text. Other languages still match through the `simple`
  index, without stemming.
