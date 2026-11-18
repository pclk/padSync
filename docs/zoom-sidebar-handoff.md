# Zoom, Mac tool sidebar and notebook panning — handoff

Branch `t3/zoom-sidebar-pan-integration`. This branch builds stages 1–3 in one go: when it
started, the tree had no earlier zoom or sidebar work (`main` and `t3/mac-drawing-toolbar-sidebar`
were both at `6f106f9`).

## What changed

- **Zoom 25%–300%.** `MIN_ZOOM` is now 0.25 (it was 0.4). `clampZoom`, `fitZoom` and the limits
  live in `src/lib/notebook-viewport.ts`. Pinch, ctrl+wheel and the reset button all go through
  them. Reset fits the page on the Mac and goes back to 100% on the iPad.
- **Mac tool sidebar.** On the desktop, `Toolbar` shows `ToolSidebar`, docked below the header at
  the left edge.
  - Expanded (184 px): each tool with its name and shortcut key, the colours, the sizes, and
    undo/redo.
  - Collapsed (52 px): the tool icons, a swatch of the current colour (click it to expand), and
    undo/redo.
  - Toggle it with the sidebar button or the `\` key. The state is saved in localStorage as
    `padsync.toolSidebar` (default: expanded).
  - Pen settings open just right of the sidebar (new `left` prop on `PenSettings`).
- **iPad rail unchanged.** `ToolRail` keeps the old markup and classes; a test pins its class
  string. Touch, Pencil, pinch, two- and three-finger tap handling is untouched.
- **Pan bounds.** The column used to be `mx-auto` with `padding-right` for the panel. It is now
  placed by `columnLayout()`:
  - A page that fits the clear strip (window minus the header, the rail or sidebar, and the side
    panel) is centred in it and does not pan sideways.
  - A wider page gets the inset plus a gutter as scroll room on both sides. Scrolled fully left,
    its left edge clears the tools; scrolled fully right, its right edge clears the side panel.
  - The editor's `min-width` is the content width, so the window scrolls sideways natively
    (two-finger trackpad or shift+wheel on the Mac, one finger on the iPad).
  - Top space is header + gutter. Bottom space is `max(50vh, gutter)`.
- **Chat panel leaves room for the notebook.** `panelWidth(mode, vw, leftInset)` still uses the
  50/50 and 25/75 shares, but never leaves less than `MIN_NOTEBOOK_VIEW` (376 px: a whole page at
  25% plus gutters) beside the sidebar. The only exception is a very narrow window, where the panel
  keeps at least 320 px and the notebook pans instead. Examples:

  | Window | Sidebar | Chat panel |
  | --- | --- | --- |
  | 1440 | none | 1064 |
  | 1440 | expanded | 880 |
  | 2560 | any | 1920 (exact 75%) |

- **Refit.** The Mac refits its zoom whenever the clear strip changes (panel, layout mode, sidebar,
  window width), and keeps the line at the top of the screen in place. It waits for the panel or
  sidebar width transition to end, or at most 300 ms.

## Coordinates

Ink mapping is unchanged: `(client − section rect) / zoom` in `InkController`. Live overlay
transforms also use per-section rects. Neither depends on where the column sits or on scroll
position. A test drives the real controller at 25%, 150% and 200%, with the column centred and
with it panned fully right, and checks the stored page points.

The Pencil capture/replay work in the other worktrees (`t3/pencil-input-recording-interface`,
`t3/pencil-session-import-export-replay`, both uncommitted) keeps the same section-local
`toLocal(clientX, clientY, rect, zoom)` contract, so it should merge without changes. This branch
does not touch `src/ink/controller.ts`.

## Tests

`tests/notebook-viewport.test.ts` covers:

- the zoom limits and fit;
- which toolbar each device gets, and its insets;
- panel widths;
- a pan-reachability sweep over each combination of:
  - devices: Mac 1024/1280/1440/1728 and three iPad sizes,
  - sidebar expanded and collapsed,
  - panel closed, drawing or chat,
  - zoom 25%–300%;
- vertical padding;
- toolbar markup for the iPad rail and for the Mac sidebar, expanded and collapsed;
- the controller coordinate check.

`tests/layout-mode.test.ts` has updated chat widths.

Checks run: `npm test` (all pass), `npm run lint`, `npm run typecheck`, `npm run build`.

## Not yet verified on real devices

- **iPad Pro 13" landscape.** At 100% zoom the page now starts 84 px from the left (clear of the
  rail), and its right 92 px need a one-finger pan. Before, the rail covered the page's left
  70 px. Check that this feels right while writing, and that sideways panning does not fight
  vertical scrolling.
- **Pinch to 25% on the iPad.** Check tile and PDF sharpness, and that the anchor stays under the
  fingers near the left and right pan limits.
- **Mac.** Check the sidebar width animation and refit with chat open, both sidebar states, and a
  classic (always-visible) scrollbar setting.
- **Follow mode.** The Mac following the iPad scrolls only vertically. A Mac panned sideways stays
  where it is.
- The UI has not been tried in a browser from this session: only unit, markup and build checks ran.
