# Context control for Ask AI (2026-11-17)

## Current flow (before this change)

1. `AskPanel` (side panel, one section at a time) renders the **current section** to a PNG
   (`sectionPng`, html-to-image + ink) and its Markdown source (`sectionSource`: blocks, typed
   notes, and the hidden solution if "use solution" is ticked).
2. `POST /api/jobs` stores `question`, `context` (≤100k chars) and `image` (≤3 MB data URL) in the
   `jobs` row. Nothing else can be chosen: always one whole section.
3. The Mac bridge claims the job, writes `section.png` and `context.md` into a fresh 0700
   `padsync-job-*` temp dir (`prepareJobDir`/`withJobDir`), and runs Claude Code
   (`--tools Read`) or Codex (`--sandbox read-only`) there. The prompt names the files by absolute
   path; their content is never inlined. The dir is removed in a `finally`, and stale ones are swept
   at start-up.
4. The answer streams back as text. The agent is told not to create or modify files, so nothing
   can come back except prose.

## Controls added

All in a collapsible **What to send** box under the question (`ContextControls`). Settings are
remembered per device.

| Control | Default | Effect |
| --- | --- | --- |
| Scope: **Whole notebook** / **Sections** / **Selection** | Whole notebook | Which sections are exported. |
| Sections list with *All*, *None*, *Only this one* | all ticked | Per-section include/exclude (used when scope = Sections). |
| Selection | off until something is selected | Uses the highlighted text in a section (captured on `selectionchange`) and/or the current lasso selection (crop of the render around the lassoed ink). Only the selection's section is sent, plus the selection files. |
| Recent only | off | Keeps only sections with activity (section edit, ink, typed text) in the last 24 h. |
| Handwriting renders | on | One PNG per section. Off = text only. |
| Typed notes | on | Text boxes. |
| Hidden solutions | on (existing "use solution") | Solutions go to the AI but it is told not to reveal them. |
| Embedded images | on | `data:` images inside blocks become `assets/` files. Off = replaced by `[image: alt]`. |
| Let AI edit a copy | on | The agent may write changed copies to `out/`. Off = read-only, as before. |
| Allow running code | off | Claude also gets `Bash` (in Claude Code's sandbox); Codex always runs commands in its own sandbox (`workspace-write` when editing, `read-only` otherwise). |
| Preview | — | Lists exactly the files that will be written (path, size), the Markdown text, thumbnails, the size/token estimate and anything skipped for size. |

The summary line ("4 sections · 3 renders · ~12k tokens · 820 KB") is always visible before
sending. The preview and the send use **the same bundle object**: once built, the bundle is cached
against a signature of (options, section hlcs, selection), and Send posts that cached bundle. If the
inputs change, the bundle is rebuilt and the preview refreshes.

## Format decision: Markdown + JSON + PNG, not PDF

For each request the client builds a small folder (`buildBundle` in `src/lib/context.ts`):

```
README.md          what each file is, and how to return changes
notebook.md        all included sections: headings, Markdown + LaTeX source, code, typed notes,
                   solutions (if included), links to renders/ and assets/
notebook.json      the same sections in padSync's import format, each with its `id`
renders/01-q1.png  per-section render: printed content + handwriting (scale 1, scale 2 for a single section)
assets/…           embedded images from blocks
selection.md/.png  only for scope = Selection
```

Why not PDF:
- The only PDF the browser can make cheaply is pages of the same raster renders. That loses the
  Markdown/LaTeX source (the AI would OCR `\int` back from pixels) and grows the payload.
- A text-layer PDF needs a PDF library plus embedded fonts and KaTeX glyphs, and text extraction
  from it is still lossy (reading order, math).
- The agent is supposed to *modify* the material and hand it back. Nobody can apply a PDF edit back
  to padSync; JSON in the import format can be validated and applied section by section.
- Claude's Read tool and Codex's image viewer read Markdown, JSON and PNG directly.

What each part preserves: the Markdown and JSON are lossless for printed content, typed text and
solutions. The PNG is the only faithful carrier for handwriting, since ink has no text form, and raw
stroke points would be large and meaningless to a model. Section order, titles, marks, tags and
time limits are in both text files.

## Temp dir, return path and clean-up

- New jobs carry `files: [{path, mime, text | base64}]` (≤64 files, ≤3.2 MB total, safe paths
  only: `[A-Za-z0-9._-]`, one optional folder, no leading dot, no `..`). Old jobs with
  `image`/`context` still work.
- The bridge writes them into the per-job dir with `wx` (no overwrite, no symlink follow) after
  checking each resolved path stays inside the dir, and creates an empty `out/`. The prompt lists
  the paths and says: read them with your tools; to change something, write the changed copy to
  `out/<same path>`, and for notebook content use `out/notebook.json` with the section ids kept.
- After the agent exits successfully, the bridge collects `out/` (regular files only, symlinks
  skipped, safe names, ≤20 files, ≤2 MB) and sends them with the final update. The server stores
  them in `jobs.result_files`. Inputs are dropped from the row when the job finishes, as
  `image`/`context` already were.
- Clean-up: inputs and outputs live in the same job dir, which `withJobDir` removes in a `finally`
  on success, agent error, timeout, cancel, shutdown and upload failure. `sweepStaleJobDirs`
  catches SIGKILL leftovers.
- In padSync, a finished job lists its returned files (download), and `out/notebook.json` gets a
  **Review changes** view: per-section diff summary (title, blocks, solution, …), with checkboxes.
  Only ticked changes are applied (`applyNotebookChanges`). New sections are appended, unknown ids
  are ignored, and nothing is deleted.

## Limits and open points

- 3.2 MB total is below Vercel's 4.5 MB body limit. When renders overflow it, the later ones are
  dropped and the preview says so. Text that is too large by itself blocks sending with a message
  to pick fewer sections.
- Token estimates are rough: about 4 chars per token for text, and width×height/750 per image,
  capped at 1,600 per image.
- Claude's Bash sandbox (`--settings {"sandbox":{"enabled":true}}`) was not exercised against a
  real agent here (no paid prompts). Running code stays opt-in.
