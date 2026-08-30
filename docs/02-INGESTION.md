# 02 — PDF Ingestion Pipeline

Goal: PDF file → `Rulebook` row + many `RuleChunk` rows in Dexie.
All heavy work runs in a **Web Worker** (`/src/workers/ingest.worker.ts`);
the pipeline logic itself lives in `/src/ingest` as pure functions so it can be
unit-tested without a worker.

## Flow

```
UI (file input, multiple PDFs allowed)
  → create Rulebook row {status:'processing'}
  → postMessage({bookId, arrayBuffer, system}) to ingest.worker
      worker:
        1. extract per-page text items (pdfjs-dist)
        2. reconstruct lines & detect headings
        3. segment into chunks (sections / stat blocks / tables)
        4. postMessage progress {bookId, page, pageCount} every 5 pages
        5. postMessage result {bookId, chunks: RuleChunkDraft[]} (no DB in worker)
  → main thread: bulkAdd chunks, update Rulebook {status:'ready', pageCount}
  → on worker error: Rulebook {status:'error', errorMessage}
```

`RuleChunkDraft` = `RuleChunk` minus `id/createdAt/updatedAt/bookId` (added on
the main thread).

pdfjs worker setup: use `pdfjs-dist` with its own worker disabled inside our
worker (`GlobalWorkerOptions.workerSrc` — use the `pdfjs-dist/build/pdf.worker.mjs?url`
Vite import in the main-thread fallback; inside our own worker call
`getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true })`).

## Step 1 — Text extraction

For each page, `page.getTextContent()` returns positioned items. Map each item
to `{ str, x, y, fontSize (from transform[0] magnitude), fontName }`.

## Step 2 — Line & heading reconstruction (pure function `buildLines(items)`)

1. Group items by rounded `y` (tolerance: 2 units) → lines; sort lines top-to-
   bottom, items left-to-right; join item strings with single spaces.
2. Compute the **body font size** = most frequent fontSize across the page
   (mode). A line is a **heading candidate** if its fontSize ≥ body×1.15, or
   its fontName differs from body font AND the line is < 60 chars.
3. Assign heading **levels** by clustering distinct heading font sizes on the
   whole document: largest size = level 1, next = level 2, etc. (max 4 levels).
4. Two-column detection: if the x-positions of line starts cluster into two
   groups separated by > 40% of page width, split into left/right columns and
   read left column fully before right.

Output per page: `Line[] = { text, headingLevel: 0|1|2|3|4, page }[]`
(0 = body text).

## Step 3 — Chunking (pure function `chunkLines(lines): RuleChunkDraft[]`)

Maintain a `headingPath: string[]` stack updated whenever a heading line is
seen (heading level n replaces stack from depth n on).

**Section chunks**: accumulate body lines under the current headingPath.
Flush a chunk when (a) a new heading appears, or (b) accumulated text exceeds
**1500 characters** — on overflow, split at the nearest sentence boundary and
continue a new chunk with the same headingPath. Discard chunks whose text is
< 40 chars (page numbers, footers). Strip repeated header/footer lines: any
line text occurring on > 60% of pages is dropped.

**Stat-block detection** (`detectStatBlock(lines, startIdx)` in
`/src/ingest/statblock.ts`): a stat block starts when within a 6-line window we
match ≥ 3 of these regexes (case-insensitive):

```
/\bArmor Class\b|\bAC\b\s*\d+/
/\bHit Points\b|\bHP\b\s*\d+/
/\bSpeed\b\s*\d+\s*(ft|feet)/
/\bSTR\b.*\bDEX\b.*\bCON\b/
/\bChallenge\b|\bCR\b\s*\d+|\bLevel\b\s*\d+/
```

The block ends at the next heading of level ≤ 2 or after 80 lines. The whole
block becomes one chunk `{chunkType:'statblock'}`; additionally try
`parseStatBlock(text): StatBlock | null` — a best-effort regex parser filling
the normalized `StatBlock` (parse abilities row, AC, HP, speed; everything not
matched goes into `extras` or stays only in `text`). Parser failure is fine:
`statBlock: null`, chunk keeps type `statblock`.

**Table detection**: a run of ≥ 3 consecutive lines where each line has ≥ 3
segments separated by gaps > 2× the median char width → one chunk
`{chunkType:'table'}`, text = lines joined with `\n`, cells joined with ` | `.

## Step 4 — contentHash

`contentHash` = SHA-256 hex of `text` via `crypto.subtle.digest`, computed in
the worker.

## Acceptance criteria

- Ingesting a text-based PDF of ~300 pages completes without freezing the UI
  and yields chunks with sensible headingPaths.
- A 5e-style stat block page yields a `statblock` chunk with parsed AC/HP/abilities.
- Re-ingesting the same PDF creates a second Rulebook (no dedup in M1).
- Scanned/image-only PDFs: pages yield no text → book completes with a warning
  toast "No extractable text on N pages" (no OCR in scope).
