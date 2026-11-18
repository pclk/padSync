# Zoom / Mac tool sidebar / panning — handoff

Three stages: 1) 25% minimum zoom and notebook reachable beside the chat panel, 2) Mac drawing
toolbar as a collapsible sidebar, 3) panning past toolbar margins.

## Status

- **Stage 1** — no separate branch existed, so the parts stage 2 depends on were done here:
  `MIN_ZOOM` is now `0.25` (`src/components/NotebookEditor.tsx`). On the Mac the editor is
  `w-max min-w-full`, so a notebook column wider than the gap between sidebar and panel (chat mode
  at ≤25% of the window) scrolls sideways instead of sitting under the panel. The iPad is unchanged.
- **Stage 2** — done (branch `t3/mac-drawing-toolbar-sidebar`, not committed yet).
- **Stage 3** — not started. Branch/worktree `t3/zoom-sidebar-pan-integration` exists, clean.

## Stage 2 design

- Device split uses the existing `deviceKind()` (`src/lib/db.ts`): iPad UA, or `MacIntel` with
  `maxTouchPoints > 1` (iPad requesting the desktop site). Not decided by width.
- `Toolbar` takes an optional `sidebar: { open, onToggle }`. With it (Mac) the same tool `<aside
  id="drawing-tools">` docks at `left:0; top:56px; bottom:0`, `TOOL_SIDEBAR_W = 64`
  (`src/lib/layout-mode.ts`). Without it (iPad) the floating rail renders exactly as before.
- Toggle: header button after "Library", `aria-expanded` / `aria-controls="drawing-tools"`, shown
  in both states. Collapsed, it also shows the active tool's icon. The open/closed state is saved in
  `padsync.toolSidebar` (default open).
- Collapsed, the sidebar stays mounted but slides out (`-translate-x-full`) and is `inert`. Tool
  state lives in the editor (`padsync.tool`), so the tool, colour and size carry over a toggle.
  Toggling closes the pen-settings popover. Keyboard tool keys (P/H/E/L/T, ⌘Z) work either way.
- Viewport: `notebookViewportWidth(window, panel, sidebar)` = window − panel − sidebar − 32. Both
  `fitZoom` callers pass the sidebar width. The editor gets `padding-left: sidebarWidth`, which
  transitions like `padding-right`. The existing refit effect now also runs on sidebar changes: it
  keeps the top section and offset in place after the padding transition, so the page does not jump.
- Pointer coordinates come from each section's `getBoundingClientRect()` at pointerdown, and the
  live canvas is fixed full-window, so the padding/scroll changes need no coordinate fixes. A
  toggle can't start mid-stroke (it's a click on the header).

## Checks

- `tests/tool-sidebar.test.ts`: the sidebar markup in both states, the iPad rail, the viewport
  arithmetic, and iPad desktop-UA classification.
- `tsc --noEmit` (app + bridge), eslint on the changed files, and the full vitest run
  (720 passed, 2 skipped) all pass.
- Not done: no browser or device run, and no `next build`. Still to check by hand:
  - Mac Safari/Chrome: toggle in Drawing and Chat modes. The notebook re-anchors, there is no
    sideways jump beyond the 32px re-centre, and sideways scroll reaches the right edge in Chat at
    25% zoom.
  - Mouse and trackpad drawing lines up after toggling and after scrolling sideways.
  - iPad (normal and desktop-site UA): floating rail unchanged, no tools toggle, no sideways scroll.
  - Reduced motion: no transition.

## Notes for stage 3

- Horizontal overflow on the Mac comes from `w-max min-w-full` on `.editor`. Pan margins for the
  header (56px) and sidebar/rail can extend that, e.g. with extra padding or scroll-padding.
- The iPad floating rail still overlaps the notebook's left edge; stage 3's pan margins cover it.
- Pencil capture/replay work is uncommitted in other worktrees (`src/ink/controller.ts`,
  `src/components/SectionView.tsx`). Stage 2 touched neither file.
