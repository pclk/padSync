# iPad app overnight queue (2026-11-22, 01:00–06:00)

Scheduled runs work through this queue in order, one item per run. The design doc
is `docs/ios-native-2026-11-21.md`, and it gives the architecture, the phases, and what phase 3a learned.

## Rules for every run

1. **Lock.** If `.git/ios-overnight.lock` exists and is under 50 minutes old, a previous run is
   still working: append "skipped, previous run still going" to the log and stop. Otherwise
   write the current time into the lock, and delete it when you finish, even when the run fails.
2. **Branch.** Work on `ios-native`. Commit with a clear message. Never push, merge into
   `main`, or deploy. Web changes under `src/` are allowed, but they stay local and
   undeployed: note in the log anything that needs a deploy to work on the device.
3. **Pick** the first unchecked item below. If it is too big for one run, do a coherent slice,
   leave it unchecked, and write in the log what is left.
4. **Check** before committing:
   - `cd ios && xcodegen generate && xcodebuild test` on the simulator
     (`id=17EA2C24-ABE0-4EC1-B630-C32D620880F3`) must pass.
   - Add tests for logic: codecs, layout maths, store changes.
   - For UI, launch in the simulator and screenshot it: the `-openNotebook <id>` launch argument
     and the seeded database copy are described in the design doc and `ios/README.md`.
   - Web changes must also pass `npm run typecheck`, `npm run lint` and `npx vitest run`.
5. **Install** on the iPad at the end of a successful run:
   `xcodebuild -scheme PadSync -destination 'id=00008132-0004791C3C79001C' -derivedDataPath build/dev -allowProvisioningUpdates build`,
   then `xcrun devicectl device install app --device 00008132-0004791C3C79001C build/dev/Build/Products/Debug-iphoneos/padSync.app`.
   If the device can't be reached, say so in the log and carry on.
6. **Never break what works.** Writing, erasing and syncing with the web all work today, as
   do the status bar strips. If a change can't be made safe, revert it and log why.
7. **Log** an entry under "Log" below with the time, the item, what changed (with commit
   hashes), what was checked, and what is left. Commit the log with the work. Also tick the
   item and update the phase status in the design doc.

## Queue

- [x] **Section blocks.** Render each section's Markdown and KaTeX blocks (`src/lib/blocks.ts`,
  `markdown.ts`, `Block` in `types.ts`) behind the canvas with the same layout and height as
  the web. Use a web snapshot: an offscreen WKWebView rendering through the web app's own
  renderer, then an image cached by section id and hlc. Section height must match the web, so
  ink lines up on both. If the deployed site lacks a route the renderer needs, ship a bundled
  HTML/JS renderer in the app instead of depending on an undeployed route.
- [x] **Text boxes.** Create, edit, move, resize and delete text boxes natively, writing the same
  entity shape the web uses. Check that the web reads them back.
- [x] **Sections.** Add a blank section after the current one (matching the web's template and
  order maths), delete a section with confirmation and undo, and show a section menu. Ink
  must not be lost.
- [x] **Rotation and window sizes.** Portrait, Split View and Stage Manager widths: refit the
  zoom, keep the reading position, and keep the tool picker working.
- [x] **Pencil Pro and tools.** Squeeze and double tap (`UIPencilInteraction`, following the
  user's preference), hover preview, and remembering the last tool, colour and width across
  launches (`PKToolPicker` state and `stateAutosaveName`). Make sure finger touches scroll
  and don't draw.
- [x] **Realtime.** Port `src/lib/sync-realtime.ts` (`/api/sync/live`) so remote ink shows
  without the 2 s poll. Keep polling as the fallback.
- [x] **Undo across remote changes.** A remote change to a section shouldn't clear that
  section's undo stack. Apply remote strokes incrementally to the PKDrawing instead of
  replacing it.
- [x] **Lasso → Ask AI.** From a lasso selection, offer Ask AI. It hands the selection (a
  rendered image plus section context, as `src/lib/ask-bundle.ts` builds it) to the web chat
  panel through the bridge, or opens the web chat with it. Pick whichever works with the
  deployed web and log the choice.
- [ ] **Phase 4 groundwork.** Read and write the native store through the
  `WKScriptMessageHandler` bridge, so the web library can show native ink without a server
  round trip. Do the native side plus a web-side adapter behind `window.padsyncNative`. It
  stays undeployed, so log exactly what needs deploying.
- [ ] **Polish.** A launch spinner, an error state when sign-in is missing, an empty notebook,
  a long-notebook scroll performance check with many sections, and memory under 1 GB.

## Log

### Morning summary — 2026-11-22

Eight runs from 01:00 to 05:45 finished seven of the ten queue items and one slice of the
eighth. The final checks at 06:00 found nothing broken, so nothing was reverted: on the simulator
`xcodebuild test` passed 80 tests in 19 suites, and the web checks passed (`npm run typecheck`,
`npm run lint`, `npx vitest run` with 922 tests). The build at `ios-native` 5f4f81b, plus this
summary, is installed on the iPad. Nothing has been pushed, merged or deployed.

**What now works on the iPad, and how to try it.** Every item below passed its tests and was
screenshotted in the simulator. The simulator is signed out and has no Pencil, though, so none of
them has been tried with a real Pencil or against the live server. These are the hand tests.

1. **Section content.** Headers, Markdown, maths, code and study blocks now draw behind the ink at
   the web's heights. *Try:* open a notebook that has blocks on the Mac and compare where the ink
   sits on both.
2. **Text boxes.** *Try:* tap the text tool (`character.textbox`) in the bar, tap the page, type,
   then tap away. Drag a box to move it, drag its right edge to resize it, and long-press it for
   Edit or Delete. Check that the box shows up on the Mac.
3. **Pages.** The page menu (`rectangle.stack`) has Blank page after, Move up, Move down and
   Delete page…. A deleted page shows a 6 s Undo banner, and the two-finger tap undoes page steps
   as well as ink. There's also a Blank page button under the last page. *Try:* add a page, draw on
   it, delete it, tap Undo, and check the ink came back.
4. **Rotation, Split View and Stage Manager.** The page refits to the window width and keeps your
   place, and the bar shrinks to icons in a narrow window. *Try:* rotate while you're partway down
   a long notebook, then put padSync next to another app.
5. **Tools.** The app remembers the last tool, colour and width across launches. With the text
   tool on, a squeeze or double tap returns you to ink. Fingers scroll and never draw. *Try:* pick
   the green fountain pen at a thicker width, draw a stroke, quit padSync from the app switcher and
   reopen it.
6. **Realtime.** Ink from the Mac should arrive in well under 2 s; polling is still the fallback.
   *Try:* open the same notebook on both devices and write on the Mac.
7. **Undo after remote ink.** *Try:* write a word on the iPad, then write on the Mac. Once that
   ink appears on the iPad, two-finger tap: the iPad's word should go and the Mac's ink stay.
8. **Ask AI.** *Try:* tap the sparkles in the bar, loop some ink or part of a PDF with a finger or
   the Pencil, type a question and tap Ask. The answer streams into a sheet, and the chat also
   appears in the notebook's chat panel on the web.

**What to test first.** Start with 6 (realtime), then 8 (Ask AI). Both depend on the live server,
and the simulator couldn't reach it. Realtime needs production's `NEON_REALTIME_URL` to be set and
the endpoint to accept the app's origin, and neither has been checked. If ink takes about 2–5 s,
realtime has fallen back to polling. Safari → Develop → iPad → the hidden padSync page shows its
console. After those, do 2 (text boxes) and 3 (pages), which also haven't been tapped through.

**Half done.**
- *Phase 4 groundwork* (item unchecked): slice 1 is in. The web screens can now read and write the
  native store through `padsyncStore`, and `src/lib/native-store.ts` is the web-side adapter.
  Nothing calls the adapter yet. Slice 2 still has to make the web library use it and decide
  whether the web screens stop running their own Dexie sync inside the app.
- *Polish* (item unchecked): not started. That covers the launch spinner, a signed-out error state,
  an empty notebook, scroll performance on long notebooks, and memory.
- Known gaps from the runs:
  - Block snapshots blur above 100% zoom, and study-block chips can't be tapped.
  - Text boxes show plain text, not Markdown or KaTeX, and aren't on the undo stack.
  - An erase or lasso move on another device still clears that page's undo; only remote additions
    keep it.
  - Ask AI starts a new chat each time, has no follow-up questions, and shows no KaTeX in replies.

**Needs a web deploy.** Nothing that works today does. Tonight's `src/` changes are local and
harmless to the deployed site:
- `SectionContent.tsx` is a refactor that the bundled renderer uses.
- `native.ts` and `native-store.ts` are the unused adapter.
- `eslint.config.mjs` adds lint ignores.

`native-store.ts` only needs deploying once phase 4's slice 2 uses it.

**Decisions made without you.**
- The app bundles its own block renderer and realtime client (built by
  `scripts/build-ios-renderer.mjs` and committed) rather than depending on undeployed routes.
  Realtime uses the web's own `@neon/realtime` client rather than a Swift port of its protocol.
- Ask AI posts to the deployed chat API itself and has its own lasso. It doesn't use PencilKit's
  lasso: there's no public API for it, and reading the selection would raise iOS's paste prompt.
  With no saved default model it uses `agent: "claude"`.
- The UI says "page", not "section". Pages can be moved up and down. Deleting the last page isn't
  allowed, as on the web.
- Text boxes can be resized (the web has no resize, so only `w` changes). Delete lives in a
  long-press menu.
- All four orientations are allowed, including upside down. The zoom refits only when the width
  changes.
- The app's saved copy is the source of truth for tool state. The ruler isn't remembered.
- Undo across remote deletes was left out. PencilKit's private `_setUUID:` made it work but
  crashed a test.

### 01:00–01:08 · Section blocks

- **What changed.** Section headers, Markdown/KaTeX, code and study blocks now render behind the
  PencilKit canvas, laid out by the web's own components. There's no render route on the deployed
  site, so the app ships a bundled renderer instead:
  - Web (local, nothing to deploy): `SectionHeader`, `MarginColumn` and `Blocks` moved unchanged
    from `SectionView.tsx` into `src/components/SectionContent.tsx`, so the editor and the
    renderer share them.
  - `ios/renderer/` (entry + page) is built by `node scripts/build-ios-renderer.mjs` into
    `ios/PadSync/Renderer/` (~1 MB: React bundle, Tailwind CSS compiled from `globals.css` for
    the shared components, KaTeX CSS + woff2 fonts, highlight.js theme). The output is committed
    so the iOS build doesn't need Node. Rebuild it after changing those components, `markdown.ts`
    or `globals.css`. It's added to the app as a folder reference (`project.yml`).
  - `BlockRenderer.swift`: one offscreen WKWebView (in the key window, off screen, since WebKit
    won't paint outside a window) renders one section at a time and snapshots it. The image and
    the content height are cached in memory and in `Caches/blocks` by renderer version +
    section id + hlc + index.
  - `SectionView` shows the snapshot and sizes the section like the web:
    `max(minHeight, contentH + 80, ink + 360, text + 200)`. The column uses the cached content
    height for sections that aren't mounted. The plain title label shows until the first render,
    and stays if a render fails.
- **Checked.** `xcodebuild test`: 20 tests pass, including the new `BlockRendererTests`, which
  check which sections render, render Markdown + math through the bundle, and test the heights
  and the cache. Web checks pass: `npm run typecheck`, `npm run lint`, `npx vitest run` (918
  tests). Simulator screenshot: I put a throwaway notebook (header with kind badge, marks and an
  objective, Markdown with inline and display math, a list, code, a callout, space, a divider,
  and a margin column on a grid section) into the simulator database, then deleted it after the
  screenshot. It renders like the web on lines and grid paper. Installed on the iPad (build and
  install succeeded).
- **Calls I made.** I worked in a t3 worktree on a branch reset to `ios-native`, then
  fast-forwarded `ios-native` to it, because `ios-native` is checked out in the main repo. The
  simulator's synced data has no sections with blocks, so the screenshot used seeded test rows.
  I took the lock as `.git/ios-overnight.lock` in the main repo's common git dir.
- **What's left (follow-ups, not blocking).**
  1. The snapshot is a bitmap at the display scale, so text gets softer above 100% zoom.
     `WKWebView.createPDF` would give a vector page to draw like the PDF backgrounds.
  2. The margin column's dashed border and rulings stop at the bottom of the snapshot instead of
     running the full section height.
  3. "Show answer" chips on study blocks can't be tapped: the snapshot isn't interactive.
  4. A section view keeps the index it was created with, which only matters for the
     "Section N" fallback title after a reorder.

### 01:30–01:36 · Text boxes

- **What changed.** (Commit "Create, edit, move, resize and delete text boxes in the iPad app".) Native text boxes, writing the web's `TextBoxData` shape (`x, y, w, text,
  fontSize, color`; other fields kept on edit):
  - `TextBoxes.swift`: `TextBoxes` (new box with `addTextBox`'s defaults, move, resize clamped to
    80 pt and the page's right edge, blank text deletes like the web's `TextEditor`, `p-1
    leading-snug` styling), `TextBoxView` (tap to edit, drag to move, right-edge handle to resize,
    long-press menu with Edit and Delete; the scroll view's pan waits for a drag on a box) and
    `TextBoxEditor` (a UITextView over the box, so Scribble works; saves on losing focus or Esc).
  - `SectionView`: text boxes are now views above the canvas, kept across updates, interactive only
    with the text tool. With the text tool the canvas takes no input and a tap on the paper adds a
    box and opens it. Writes save straight to the store (fresh hlc, dirty) and request a sync, and
    log `text_create` / `text_edit` / `text_delete` events like the web.
  - `NotebookViewController` / `NotebookScreen`: a text tool button in the bar
    (`character.textbox`). Choosing a tool in the PencilKit tool picker turns the text tool off. The
    canvas isn't made first responder while the text tool is on, so scrolling doesn't end an edit.
  - `SectionView.pageWidth` is `nonisolated` so the pure helpers can use it.
- **Checked.** `xcodebuild test`: 25 tests pass, including the new `TextBoxTests` (web defaults
  and exact field set, move keeps other fields, resize clamps, blank deletes, store round trip).
  Simulator screenshot with two seeded text boxes (deleted afterwards): positions, wrapping,
  colour and size render as expected, and the text tool button shows in the bar. Installed on the
  iPad (build and install succeeded). No web changes.
- **Not checked.** I couldn't drive taps and drags in the simulator, so creating, editing, moving,
  resizing and deleting weren't exercised by hand. The simulator is signed out, so there was no live
  round trip to the web either; the shape matches `TextBoxData` field for field, and the web reads
  rows generically. Worth a quick hand test on the iPad: tap the text tool, tap the page, type, tap
  away, then drag the box and check the Mac.
- **Calls I made.** The web has no resize, so resizing only changes `w` (which the web already
  draws). Delete lives in a long-press menu rather than a toolbar. Text shows as plain text, not
  Markdown/KaTeX like the web. I copied `ios/Config/Local.xcconfig` (gitignored) from the main repo
  into the worktree so the device build could sign.
- **What's left (follow-ups, not blocking).**
  1. Render text box Markdown/KaTeX (e.g. through `BlockRenderer`) instead of plain text.
  2. Text box edits aren't on the undo stack (the two-finger tap undoes ink only).
  3. A box deleted on another device while it's being edited here loses the edit.


### 02:00–02:20 · Sections

- **What changed.** (Commit "Add, move and delete sections in the iPad app".)
  - `Sections.swift`: the web's store.ts maths. `newSection` is `insertSectionAfter` (a
    `blankSection()`: dots, `minHeight` 1032, no blocks; order halfway to the next section, or
    +1 after the last), `swapped` is `swapSectionOrder`, delete only flags `deleted` like
    `setDeleted`, and the last section can't be deleted (the web disables that too).
  - `NotebookViewController`: add after the current section (the one 30% down the screen, as
    for presence), add at the end, move up/down, delete and restore. Every write registers an
    undo step on the window's undo manager, so the two-finger tap and the bar's undo button
    undo page changes as well as ink, and redo works. Undo writes back over the current row,
    so a sync in between doesn't lose it. The view scrolls to a new or moved section. The web's
    "Blank page" button now sits under the last section.
  - `NotebookScreen`: a page menu in the bar (`rectangle.stack`) headed "Page N of M" with
    Blank page after, Move up, Move down and Delete page…; delete asks for confirmation, then
    shows a "Page deleted · Undo" banner for 6 s.
  - Fix: a section mounted taller than its estimate didn't move the sections below it, so they
    overlapped (visible as a missing gap). `mountVisible` now lays the column out again when a
    mounted height differs.
- **Ink.** Deleting a section doesn't touch its strokes or text boxes (same as the web: "Its
  ink is kept in history"), so restoring it brings everything back. A test checks this against
  the store.
- **Checked.** `xcodebuild test`: 31 tests pass, including the new `SectionsTests` (order
  maths for middle, end and empty, the exact field set, swap, last-section guard, delete and
  restore keep the ink and stamp a newer hlc). Simulator screenshot with a seeded two-section
  notebook (deleted afterwards): the page menu button, the "Blank page" button below the last
  section, and the gap between sections are right. Installed on the iPad (build and install
  succeeded). No web changes.
- **Not checked.** As in the last run, I couldn't tap in the simulator, so the menu, the
  confirmation, the Undo banner and the undo steps weren't exercised by hand, and there was no
  live round trip to the web. Worth a quick hand test on the iPad: page menu → Blank page after,
  draw on it, Delete page…, Undo, then two-finger tap to undo the add.
- **Calls I made.** The UI says "page" rather than "section", matching the web's "Blank page"
  button. The menu acts on the current section rather than adding a per-section button, since
  the page fills the width at 1:1. I added Move up/down because the web's side panel has them
  and the order maths is the same. The add button's border is solid, not dashed like the web's.
- **What's left (follow-ups, not blocking).**
  1. Section title, template and the side panel's outline (jump to a section) aren't native yet.
  2. Undoing a page step while that page's canvas has its own ink undo steps interleaves them
     in one stack; that's intended, but worth a feel test.

### 02:30–02:50 · Rotation and window sizes

- **What changed.** (Commit "Rotate the iPad app and fit the page to any window size".)
  - `project.yml` / `Info.plist`: all four orientations (portrait was off). There's no
    `UIRequiresFullScreen`, so Split View and Stage Manager can size the window.
  - `ZoomFit.swift`: the maths. Fit = window width / 1376. On a width change, a page that filled the
    old width fills the new one; a zoom the user picked is kept, clamped to the new limits
    (minimum `min(0.5, fit)`, maximum 4). The reading position is the column point at the
    viewport's top-left, which doesn't depend on zoom because sections keep their size, and it's
    put back clamped to the content (a page narrower than the window stays centred).
  - `NotebookViewController`: remembers that point on every scroll (except mid-resize, when the
    offset is stale), and `viewDidLayoutSubviews` refits when the width changes, then mounts the
    visible sections (PDFs re-render at the new zoom) and re-shows the tool picker on the current
    canvas, so it docks or floats for the new size class. Before this the first fit was the only
    one: rotating kept the old zoom and the old offset.
  - `NotebookScreen`: in a compact-width window the bar drops its labels (Library and the sync
    badge become icons, with accessibility labels) and tightens its spacing, so it fits a narrow
    Split View.
- **Checked.** `xcodebuild test`: 40 tests pass, including the new `ZoomFitTests` (fit, minimum,
  refit, offset clamping and centring) and `ResizeTests`, which hosts the real controller in a
  window over an in-memory notebook of 10 pages and resizes it: landscape → portrait (zoom 0.75,
  same point at the top) → a third of the screen → landscape (zoom 1, back at the same place),
  then a 2× zoom kept across a rotation with x and y unchanged. Simulator screenshot: the app now
  opens in portrait (the simulator's default) with the page fitted to the width and the tool
  picker showing. Installed on the iPad (build and install succeeded). No web changes.
- **Not checked.** This Mac has no Simulator.app (the simulator runs headless), so I couldn't
  rotate it or open Split View by hand; the hosted test covers the resize path instead. Worth a
  hand test on the iPad: rotate while reading a long notebook, then put padSync beside another
  app in Split View and in Stage Manager, and check the tool picker and the text tool.
- **Calls I made.** Portrait upside down is allowed too (iPad convention). A refit only follows
  width changes; height changes (keyboard, banner) leave the zoom alone. I made the controller's
  `scrollView` internal (was private) so the test can drive it.
- **What's left (follow-ups, not blocking).**
  1. The web screens (library, chat) are a WKWebView and follow the web's own responsive layout;
     not checked at narrow widths.
  2. In a very narrow window the bar's title truncates hard; a two-line bar might read better.

### 03:00–03:22 · Pencil Pro and tools

- **What changed.** (Commit "Remember the iPad's last tool and let the Pencil leave the text tool".)
  - `Tools.swift`: the tool picker is built here now (same tools as before: pen, fountain pen,
    monoline, highlighter, whole-stroke eraser, lasso, ruler). The ink items have fixed ids
    (`padsync.pen` …; the eraser, lasso and ruler keep PencilKit's own ids). The last selected
    item and each ink item's colour and width are saved as JSON in `UserDefaults`
    (`padsync.notebook.toolState`) and the next launch builds the items from them. Bad saved
    values (a colour that isn't hex, a width outside the ink's valid range, an unknown id) fall
    back to the defaults. `stateAutosaveName` (`padsync.notebook.tools`) is set as well.
  - `EditorContext.rememberTool`: saves when the picker's selection changes and when a stroke
    starts (the canvas's tool then carries colour and width changes made in the picker). It only
    writes when something changed.
  - Pencil double tap and squeeze: while the tool picker shows, it handles both itself, following
    Settings → Apple Pencil. With the text tool on, the picker is hidden, so neither did anything.
    Now a `UIPencilInteraction` on the notebook, enabled only while the text tool is on, goes back
    to ink on a double tap or a squeeze (when it ends), unless the user's preference is "ignore".
  - Fingers: the canvas's `drawingPolicy` comes from `Tools.drawingPolicy` (`.pencilOnly` on the
    device, `.anyInput` in the simulator, as before). The picker's "draw with finger" toggle is
    hidden (`showsDrawingPolicyControls = false`), because it would do nothing.
  - Hover: PencilKit shows the hover preview itself on a Pencil Pro / M4 iPad (the system's
    Settings → Apple Pencil → Show Hover). There's no API to switch it on and nothing in the
    notebook covers the canvas outside the text tool, so I changed nothing for it.
- **Checked.** `xcodebuild test`: 46 tests pass, including the new `ToolsTests` (default items and
  ids, the finger toggle hidden, recording the selection and ink, ignoring the ruler and unknown
  or mismatched tools, a save → load → picker round trip that brings back the selection, colour
  and width, falling back on bad saved values, saving only on change, the drawing policy and the
  Pencil preference rule). Simulator screenshot: the notebook opens with the tool picker showing
  the same tools as before. Installed on the iPad (build and install succeeded). No web changes.
- **Not checked.** The simulator has no Pencil, so double tap, squeeze and hover weren't
  exercised, and I couldn't check by hand that a new launch shows the last tool. Worth a hand test
  on the iPad: pick the fountain pen in green at a thicker width, draw a stroke, quit padSync from
  the app switcher and reopen: it should still be the green fountain pen. Then turn the text tool
  on and squeeze or double tap: the bar's text button should go off and the picker come back.
- **Calls I made.** I kept the app's own saved copy as the source of truth, because what
  `stateAutosaveName` keeps for custom (`toolItems`) pickers isn't documented and can't be tested
  in the simulator; both describe the same state, so they don't fight. The ruler isn't saved
  (it's a toggle, not a tool). No haptics on tool change: the system already gives one on squeeze.
  As before, I worked in a t3 worktree reset to `ios-native` and fast-forwarded `ios-native` to it.
- **What's left (follow-ups, not blocking).**
  1. If the picker's own items don't pick up colour changes until a stroke is drawn, a colour
     changed and never used isn't remembered. That's by design (it saves on use), but worth
     knowing.
  2. Barrel roll needs nothing from the app (PencilKit shapes the fountain pen and marker nibs).

### 03:30–03:45 · Realtime

- **What changed.** (Commit "Wake the iPad's sync from Neon Realtime instead of the 2 s poll".)
  - `Sync/Realtime.swift`: `Realtime` ports `startRealtime` from `src/lib/sync-realtime.ts`: fetch
    the capability from `POST /api/sync/live` (with the web view's session, like sync), subscribe,
    notify on the first live snapshot and whenever the rows' signature changes, renew 10 s before
    the sealed query expires (renew at once on `stale`), fall back on `error`/`closed`/a failed
    fetch with the web's backoff (2 s doubling to 60 s), retry every 60 s when the server says
    `enabled: false`, and drop the connection when a renewal comes back for a different login.
    Generations keep snapshots from an old subscription out.
  - The socket is the web's own `@neon/realtime/client` (v0.2.1, protocol v2), not a Swift port of
    the wire protocol: it's experimental (v2 needs `client_info`, MVCC batches, moves) and could
    change under a hand port. `ios/realtime/main.ts` is a thin bridge (connect, renew, close; posts
    each snapshot to a `realtime` script handler). `scripts/build-ios-renderer.mjs` bundles it into
    `ios/PadSync/Renderer/realtime.js` (~130 KB, committed; rebuild after changing it or upgrading
    `@neon/realtime`). `WebRealtimeSocket` loads it in a hidden 1×1 web view, off screen in the key
    window (so WebKit doesn't throttle it), with the page's base URL set to the server, so the socket
    opens from the same origin as the web app's. A crashed web content process reports `closed`.
  - `SyncEngine`: `realtimeLive` makes the poll 5 s while a notebook is open (the web's
    `FOLLOW_RECOVERY_MS`, since Neon can drop a notification while looking live) and 30 s otherwise
    (`REALTIME_RECOVERY_MS`; the hidden 60 s poll is longer anyway). Losing live polls again at once.
    `onWake` lets the app reconnect realtime when the network comes back.
  - `AppModel`: realtime runs only while a notebook is open and the app is in the foreground (the web
    screens run their own); notifications call `requestSync(after: 0)`; sign-in reconnects it.
  - `eslint.config.mjs`: ignores `ios/PadSync/Renderer/**` and `ios/build/**`. `npm run lint` was
    failing on the committed `renderer.js` bundle (from the first run) and on GRDB's JS under Xcode's
    derived data in `ios/build`.
- **Checked.** `xcodebuild test`: 56 tests pass, including the new `RealtimeTests`: capability
  decoding, the timing maths, notify on first live and on change only, ignoring a closed
  subscription's snapshots, fallback and reconnect on wake, `enabled: false`, signed out, renewal
  and a login change, `stale` renewing at once, the live poll delays, and a smoke test that loads the
  real bundle in a WKWebView and subscribes with a well-formed (fake) capability: the client accepts
  it and reports a non-live state. Web: `npm run typecheck`, `npm run lint`, `npx vitest run` (918)
  pass. Simulator: launches into a notebook as before (signed out, so realtime falls back). Installed
  on the iPad (the first install attempt lost the device connection; the retry succeeded).
- **Not checked.** No live round trip: the simulator is signed out and I can't sign in, so the
  socket never met the real Neon endpoint. Whether production has `NEON_REALTIME_URL` set, and
  whether the endpoint accepts this origin, are unverified. Nothing to deploy: it uses the deployed
  `/api/sync/live`. Worth a hand test on the iPad: open a notebook on the iPad and the Mac, write on
  the Mac, and the ink should appear on the iPad in well under 2 s. Safari → Develop → (iPad) shows
  the hidden page (padSync, about:blank-like, at the server URL) for its console.
- **Calls I made.** Hosted the JS client instead of porting the protocol (above). The capability
  fetch and the state machine stay in Swift so they're testable and share sync's session handling.
  No realtime indicator in the bar; the status is only internal.
- **What's left (follow-ups, not blocking).**
  1. A `live` status in the sync badge (the web shows it in its debug panel only).
  2. The NWPathMonitor wake only fires when a path becomes satisfied; going offline relies on the
     socket's own error to fall back.

### 04:00–04:10 · Undo across remote changes

- **What changed.** (Commit "Keep the iPad's undo when another device adds ink".)
  - Found the cause with a probe in the simulator: PencilKit's undo steps are `PKUndoCommand`s that
    name their drawing by UUID. `canvas.drawing = PKDrawing(...)`, and even editing a drawing's
    `strokes`, makes a new UUID, so after a remote change every undo step for that section quietly
    did nothing (the stack wasn't emptied, so the two-finger tap just didn't respond).
    `PKDrawing.append` keeps the UUID.
  - `InkMerge.swift`: `plan` compares the canvas's strokes (by the ids they were drawn or read as)
    with the store: nothing to do, append the new ids (in paint order), or redraw. It redraws when
    a stroke was removed or changed elsewhere (newer hlc), when the canvas has a stroke the store
    doesn't know, or when a new highlighter would land on top of pen ink (the web paints
    highlighters first).
  - `SectionView.reload` follows the plan: appends new strokes to the current drawing (undo kept),
    otherwise rebuilds it as before. `NotebookViewController.views` is readable by tests.
- **Checked.** `xcodebuild test`: 61 tests pass, including the new `InkMergeTests`: the plan
  (append, nothing, redraw on delete/change/unknown, highlighter order) and a PencilKit test
  that registers an undo step the way the canvas does (its private `undoableAddNewStrokes:` +
  `registerWithUndoManager:target:selector:`, because the simulator can't draw): after a remote
  stroke is appended, undo takes back the user's stroke and leaves the remote one, and redo brings
  it back; after a redraw the same step does nothing. A hosted test runs the real `SectionView`:
  a stroke written to the store is appended to the same drawing (same UUID), and a delete removes
  it. Simulator screenshot: a synced 133-stroke notebook opens with all its ink. Installed on the
  iPad (build and install succeeded). No web changes.
- **Not checked.** A real Pencil stroke's undo after remote ink, by hand. Worth a hand test on the
  iPad: open a notebook on the iPad and the Mac, write a word on the iPad, write on the Mac, wait
  for it to show on the iPad, then two-finger tap: the iPad's word goes, the Mac's ink stays.
- **Calls I made.** I ticked the item although remote *deletes and edits* (an erase or lasso move
  on another device) still redraw and clear that section's undo, as before: there's no public
  PencilKit call to remove or replace a stroke in place. I tried keeping the UUID on a rebuilt
  drawing with PencilKit's private `_setUUID:`; it made undo work in the probe, but PencilKit
  logged "Replica Manager Error" and one test crashed, so it's out. Additions, the common case
  while following someone writing, now keep undo.
- **What's left (follow-ups, not blocking).**
  1. Keep undo across remote deletes/moves. A possible route is building the remote change as a
     PencilKit CRDT merge (`PKDrawing.append` of a drawing derived from the same one), which needs
     research; or an app-level ink undo stack that replaces PencilKit's.
  2. A new remote highlighter under existing ink still redraws (ordering).


### 04:30–04:55 · Lasso → Ask AI (slice 1 of 2: capture)

- **What changed.** (Commit "Capture a lasso selection for Ask AI in the iPad app".)
  `Notebook/AskSelection.swift`, the native half of the web's `cropSelection`
  (`src/lib/ask-bundle.ts`) and `selectionText` (`src/lib/context.ts`): the selected strokes' box,
  the crop maths (24 pt margin, floored/ceiled to whole pixels, clamped, scale 2 lowered so a side
  stays under 16,384 px), a PNG of the section view as shown (paper, PDF, blocks, ink, text boxes)
  cropped to it, and `selection.md` with the web's exact text. Nothing in the UI uses it yet.
- **Checked.** `xcodebuild test`: 68 tests pass, including the new `AskSelectionTests` (crop
  maths, rounding, clamping, tall-section scale, stroke box, `selection.md` against the web's text,
  and a rendered PNG's size). No UI change, so no screenshot. No web changes. Installed on the iPad (build and install succeeded).
- **Calls I made (hand-off route, for the next run).** The web chat only exists inside the web
  notebook editor (`ChatPanel` in `SidePanel`/`NotebookEditor`), which the app replaces, and there's
  no route that opens it with a selection. So "hand it to the web chat panel through the bridge"
  needs an undeployed web change. The route that works with the deployed web: the app posts the
  turn itself with the web view's session, as `useChat.send` does — `POST /api/chat/threads`
  (notebookId, agent/options from `/api/prefs` `chat.defaultModel` or the catalog default),
  `POST /api/chat/threads/:id/turns` with `files` = `README.md` + `selection.md` + `selection.png`
  (base64) and a `ContextSummary`, then shows the answer by polling `GET /api/chat/threads/:id`
  in a native sheet (plain Markdown first). I stopped short of it to finish inside the run.
  Getting the lasso selection itself is the other open question: PencilKit has no public API for
  the current lasso selection or for adding to its edit menu. Plan: an "Ask AI" bar button that
  is enabled while the lasso tool is active and asks about the strokes the last lasso selected,
  read by diffing the canvas after PencilKit's Copy (the pasteboard holds a `PKDrawing`), or
  falling back to the strokes in the visible part of the current section.
- **What's left.** Slice 2: the selection source above, the chat API calls (`ChatClient`), the
  answer sheet, and a hand test. Item stays unchecked.


### 05:00–05:08 · Lasso → Ask AI (slice 2 of 2: ask and answer)

- **What changed.** (Commit "Ask AI about a lasso selection from the iPad app".)
  - `Chat/AskBundle.swift`: the web's `buildBundle` for scope "selection" (src/lib/context.ts):
    `README.md` (the web's selection readme, without "Returning changes": the app takes no edits
    back), `selection.md`, `selection.png`, and the `ContextSummary` (scope `selection`, label
    "1 section · ~N tokens", bytes and tokens counted as the web does). An image that would pass
    the 3.2 MB bundle limit is dropped, and with no typed text it's refused ("Lasso a smaller area").
  - `Chat/ChatClient.swift`: the chat calls `useChat` makes, with the web view's session:
    `GET /api/prefs` (`chat.defaultModel`), `POST /api/chat/threads`, `POST …/turns`, `GET …/:id`.
    401/503/other errors are named. The transport is swappable for tests.
  - `Chat/AskLasso.swift` + `NotebookViewController.setAskMode`: a sparkles button in the bar turns on
    Ask AI; a see-through layer takes one finger or Pencil loop (dashed), picks the section most of
    it is on and the strokes it encloses with the web's "enclose" rule (`AskSelection.enclosed`, half
    of up to 24 samples inside, even-odd test as `pointInPolygon`), then crops the picture with
    slice 1's `AskSelection.png`. A loop with no ink inside asks about the area itself, so a printed
    question or PDF part can be asked about too.
  - `Chat/AskSheet.swift`: a sheet with the picture, a question field and Ask. It makes a new chat
    on the notebook and sends the turn, then polls the thread every 1.5 s until the turn is done,
    error or cancelled, showing the reply as it streams (inline Markdown; no KaTeX). Closing the
    sheet stops polling; the chat stays on the server.
  - A DEBUG-only `-askDemo` launch argument draws a lasso over the top of the screen after 2 s, so
    the sheet can be checked in the simulator.
- **Checked.** `xcodebuild test`: 76 tests pass, with new `AskBundleTests` (files, readme text,
  tokens/bytes/label, `fileBytes` matching `JSON.stringify`, the size limit), `ChatClientTests`
  (a fake server: the request order and bodies for prefs → thread → turn, the Claude fallback with
  no saved default, polling, named errors) and `AskLassoTests` (even-odd with a concave loop, the
  enclose rule). Simulator screenshots: the bar's sparkles button, and the sheet after `-askDemo`
  with the cropped ink and the question field. Installed on the iPad (build succeeded; the first
  install attempt lost the device connection, the retry installed). No web changes, so nothing to deploy.
- **Not checked.** A real send: the simulator is signed out, so the server round trip (thread,
  turn accepted by `newTurnSchema`, bridge reply) is only covered by the fake-server tests.
  Hand test on the iPad: open a notebook, tap the sparkles, loop some ink, type a question, Ask;
  the reply should appear in the sheet, and the chat in the notebook's chat panel on the web.
- **Calls I made.** Route: the app posts the turn itself through the deployed chat API (as planned
  at 04:30), because opening the web chat panel with a selection needs undeployed web changes.
  Selection source: Ask AI draws its own lasso instead of reading PencilKit's (no public API, and
  reading the pasteboard after Copy would raise iOS's paste prompt). No saved default model →
  `agent: "claude"` with empty options, so the bridge picks its default model (the web picks the
  catalog's first, which needs `/api/chat/catalog`). Every ask starts a new chat; the web reuses
  an untouched one. I ticked the item with the hand test above still owed.
- **What's left (follow-ups).** Follow-up questions in the sheet (send more turns to the same
  thread); KaTeX in replies (the bundled renderer could draw them); "Open in web chat" from the
  sheet; reuse an untouched empty chat like the web.

### 05:30–05:45 · Phase 4 groundwork (slice 1: the bridge)

- **What changed.** (Commit "Let the web screens read and write the iPad's native store".)
  - `ios/PadSync/Web/StoreBridge.swift`: a `WKScriptMessageHandlerWithReply` on `padsyncStore`
    (page content world), so each `postMessage` from the page returns a promise. Ops: `get {id}`,
    `list {notebookId, kind?, parentId?, includeDeleted?}` (live rows unless asked, id order),
    `notebooks {}` and `put {entities}`. Rows go both ways in the Dexie shape (`deleted`/`dirty`
    as 0/1). `put` goes through `AppDatabase.save`, so the app stamps its own hlc and marks the rows
    dirty whatever the page sent, then asks the sync engine to push ("web store write"). A GRDB
    region observation on `entity` fires `padsync-native-change` on the page, at most every 250 ms,
    after any commit (native ink, sync pulls, bridge writes).
  - `WebScreen` registers the handler with the app's database; the bridge script now sets
    `window.padsyncNative = { version: 2, store: true }`.
  - Web (local, undeployed): `src/lib/native-store.ts`, `nativeStore()` returns `get`, `list`,
    `notebooks`, `put` and `onChange`, or null outside the app or in an older app build. Nothing
    calls it yet.
- **Checked.** `xcodebuild test`: 80 tests pass, with new `StoreBridgeTests` (Dexie shape, list
  filters and soft deletes, `put` stamps a newer hlc with the app's device and marks dirty, bad
  requests refused, empty put doesn't count as a write). Web: `npm run typecheck`, `npm run lint`,
  `npx vitest run` (922 tests, with new `tests/native-store.test.ts` against a fake handler).
  Simulator: the app launches and the web screen loads with the handler registered (screenshot).
  Installed on the iPad (build and install succeeded; this worktree needed `ios/Config/Local.xcconfig` copied from the main checkout for signing).
- **Not checked.** A real page calling the bridge: nothing deployed uses it, and the simulator is
  signed out. To try it on the iPad: Safari → Develop → iPad → padSync console,
  `await webkit.messageHandlers.padsyncStore.postMessage({op: "notebooks"})`.
- **Calls I made.** Requests run on the main thread: the body and reply aren't `Sendable`, and
  SQLite answers one notebook's rows in milliseconds; move to a background read if the library
  ever lists every stroke. `put` takes the web's rows but not its hlc, so the native clock stays the
  only writer of native rows. Change events carry no detail (which notebooks changed); the web
  re-runs its queries.
- **What needs deploying.** Only `src/lib/native-store.ts`, and only once something uses it. The
  native side is harmless to the deployed web, which ignores `padsyncNative.store`.
- **What's left (item stays unchecked).** Slice 2: use the adapter in the web library behind
  `nativeStore()` (notebook list, thumbnails and last-edited times from native rows), and decide
  whether the web screens stop running their own Dexie sync inside the app (they'd then write
  through `put`). Events (`PadEvent`) and `meta` aren't bridged yet.

