# Zoom, Mac sidebar and toolbar margins — handoff

Goal (3 stages): 25% minimum zoom; the notebook stays usable beside the Mac chat panel; on the Mac
the drawing toolbar becomes a togglable sidebar (iPad toolbar unchanged); the page can be panned
past toolbar margins so no chrome hides unreachable content.

## Stage 1 — zoom floor and panel-aware viewport ✅ (2026-11-18)

- **`src/lib/viewport.ts`** (new, pure, tested in `tests/viewport.test.ts`) owns the zoom limits and
  the layout math: `MIN_ZOOM` 0.25 (was 0.4 in `NotebookEditor`), `MAX_ZOOM` 3 (unchanged),
  `clampZoom` (non-finite → fallback; 0 or less → floor), `parseZoom` (saved values),
  `notebookInsets`, `regionWidth`, `fitZoom`, `stageWidth`/`stageMinWidth`, `pageLeft`.
- Every zoom path uses `clampZoom`: two-finger pinch (live transform and commit), trackpad
  ctrl+wheel, the % reset button, the Mac's fit, and the restored zoom. There are no other zoom
  controls (no +/− or ⌘= shortcuts).
- **Insets.** Mac: left = `DESKTOP_RAIL_INSET` (82 px: the floating rail plus `left-3`), right = side
  panel width when open. iPad: left 0 (rail still floats over the page, as before), right = 360 when
  the panel is open. The page fits (≤100%) and centres in the space between, with a 16 px
  `PAGE_GUTTER`. Widths come from `document.documentElement.clientWidth`.
- **Wider than the space** (chat mode at 25% on a 1440 px window, or zoomed in): the editor gets
  `width: max(100%, stageMinWidth)` with padding = insets + gutter, so the document scrolls sideways
  and both page edges can be brought out from under the rail and the panel. Previously the page slid
  under the fixed panel and could not be reached. `html { overscroll-behavior-x: none }` while the
  editor is mounted stops a sideways pan from swiping back to the library.
- **Refit (Mac only)** runs when the insets change (chat/drawing switch, panel toggle or resize,
  window resize), after the padding transition; it keeps the line at the top of the screen in place
  and scrolls back to x = 0. Reset anchors the top line and also returns to x = 0.
- **Persisted zoom.** `padsync.position.<id>` now also stores `zoom`; the iPad reopens at it
  (clamped; legacy entries without it open at 100%). The Mac ignores it and fits to its layout.
  A zoom that needs no scroll still saves (separate effect on `zoom`).
- `useLayoutMode` starts from the real `window.innerWidth`, so the Mac's first fit is right
  instead of being computed for 1024 px and corrected 400 ms later.
- Drawing coordinates are untouched: the controller still maps `(client − section rect) / zoom`,
  which is independent of where the page sits or the scroll position.

Verification: `npx vitest run` (all pass), `npm run typecheck`, eslint on changed files,
`npm run build`. **Not checked in a real browser or on the iPad** — please try chat-mode pan on a
MacBook and iPad pinch to 25% (memory: ink tiles drop to 0.5× density there; PDF backgrounds stay at
the existing half-density floor from `pdfDensity`).

## Stage 2 — Mac drawing toolbar as a togglable sidebar (todo)

- Render the tool rail as a docked left sidebar on desktop only (`deviceKind() !== "ipad"`); keep
  `Toolbar`'s current rail markup for the iPad.
- Pass its width (or 0 when hidden) as `toolInset` to `notebookInsets`; the Mac refit already
  re-runs on inset changes and listens for `padding-left` transitions. Persist the toggle with
  `useStoredState`. Consider hiding it by default in chat mode (it costs 82 px of a ~360 px region).

## Stage 3 — pan past toolbar margins (todo)

- iPad: the floating rail still covers the page's left ~82 px at 100%; add scroll room (left
  padding / horizontal overscroll space) so that strip can be panned clear without changing the rail.
- Top: confirm the first section can be scrolled fully below the 56 px header at every zoom;
  bottom already has `mb-[50vh]`.
- Keep the follow-the-iPad and position-restore math (`TOOLBAR_H` offsets) consistent.
