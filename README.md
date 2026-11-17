# padSync

Apple Pencil notes on the iPad that show up live on the Mac, ready to hand to Claude or ChatGPT.
No AirDrop, no Handoff, no PDF round trip.

- **iPad**: a PWA you add to the Home Screen. Landscape, sized to the 13" iPad Pro (1376 px wide),
  continuous sections instead of fixed pages. Works fully offline and syncs when back online.
- **Mac**: the same app in a browser, with a side panel that follows what the iPad is on, copies a
  section as an image or as question text, shows per-section activity, and reveals hidden solutions.
- **AI payloads**: the *AI prompt* page generates a prompt that makes Claude/ChatGPT return padSync
  JSON (markdown + LaTeX, code, images, answer space, hidden solutions). Paste the reply on *Import*.

## Setup (Vercel + Neon)

1. Import this repo in Vercel and add the **Neon** integration (it sets `DATABASE_URL`). Tables are
   created on the first sync, so there is no migration step.
2. Add environment variables:

   | Name | Value |
   | --- | --- |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from a GitHub OAuth app (see below) |
   | `SESSION_SECRET` | random string, e.g. `openssl rand -base64 32`; changing it signs all devices out |
   | `ALLOWED_GITHUB_LOGIN` | optional, defaults to `pclk`; the only account allowed in |
   | `CANVAS_TOKEN` | NUS Canvas access token (Account → Settings → Approved Integrations) |
   | `CANVAS_TOKEN_EXPIRES` | e.g. `2026-12-16T00:00:00+08:00` (NUS caps tokens at 30 days) |
   | `CANVAS_BASE_URL` | optional, defaults to `https://canvas.nus.edu.sg` |

3. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps → New):
   homepage `https://<your-domain>`, callback `https://<your-domain>/api/auth/github/callback`.
4. On the iPad: open the site in Safari → Share → *Add to Home Screen*, open it from there, and
   tap *Sign in with GitHub* on *Settings*. Do the same in the Mac browser.

Without `DATABASE_URL` the app still runs and stores everything on the device ("Local only").

## Using it

| Action | iPad | Mac |
| --- | --- | --- |
| Write | Apple Pencil (fingers never ink) | mouse / trackpad |
| Scroll / zoom | one finger / two-finger pinch | scroll / pinch |
| Undo / redo | two-finger tap / three-finger tap | ⌘Z / ⇧⌘Z |
| Tools | toolbar | `P` pen, `H` highlighter, `E` eraser, `L` lasso, `T` text |

Sections grow as you write near the bottom. Lasso to move or delete strokes. Text boxes accept
`$LaTeX$`.

## Ask AI from padSync (Mac bridge)

The side panel's **Ask AI** box queues your question with a bundle of files: by default the whole
notebook as `notebook.md` (Markdown + LaTeX), `notebook.json` (padSync format, with ids), a PNG
render of each section (your handwriting) and embedded images. **What to send** narrows it: pick
sections, send only a selection (highlighted text and/or lassoed ink), only recently changed
sections, or turn off renders, typed notes, hidden solutions or images. The size and token estimate
is always shown, and **Preview** lists exactly the files that will go. A small bridge on your Mac
picks the job up, writes the files to a private temp folder, runs **Claude Code** or **Codex**
locally (on your subscription) to read them with its own tools, and streams the answer back. With
*let AI edit a copy* on, the agent writes changed copies to `out/`; they come back with the answer,
and a returned `notebook.json` can be reviewed and applied section by section. Jobs asked while the
Mac is off wait until the bridge comes back. Design: [docs/context-control-2026-11-17.md](docs/context-control-2026-11-17.md).

1. padSync → *Settings* → *Device tokens* → **Create token**, then copy it.
2. On the Mac, in this repo (Node ≥ 22.18; `claude` and/or `codex` logged in):

   ```bash
   pbpaste | node bridge/padsync-bridge.ts setup --server https://pad-sync.vercel.app
   node bridge/padsync-bridge.ts install   # runs in the background via launchd, starts at login
   node bridge/padsync-bridge.ts status    # check agents + token
   ```

   Logs: `~/Library/Logs/padsync-bridge.log`. `uninstall` removes the launchd agent.

**Device tokens** (`src/server/tokens.ts`):
- 256-bit random tokens with a `psd_` prefix. The server stores only their SHA-256, and the
  plaintext is shown once.
- Scoped to `/api/bridge/*`: a token can claim and answer jobs, but it can't sync, read notebooks,
  list jobs, or create or revoke tokens. A request that sends a token to a session-only endpoint
  gets 403, even if it also has a session cookie.
- Revocation takes effect on the next request; a running bridge exits when its token is rejected.
- The bridge reads the token from stdin (never argv), stores it in `~/.config/padsync/bridge.json`
  (mode 600), requires https, and refuses redirects. Agents run in a throwaway directory without
  padSync's credentials in their environment. Claude gets only the `Read` tool and no MCP servers
  (`--tools Read --strict-mcp-config`); Codex runs with `--sandbox read-only`. With *let AI edit a
  copy*, Claude also gets `Glob`, `Grep`, `Write` and `Edit` under `--permission-mode acceptEdits`
  (edits approved only inside the job folder), and Codex runs with `--sandbox workspace-write`.
  *Allow running code* (off by default) adds `Bash` for Claude with Claude Code's sandbox enabled.
- Limits: this is tool restriction, not filesystem isolation. A read-capable agent can still
  read files your user can (including the bridge config), and two processes sharing one token
  aren't told apart. See [docs/bridge-review.md](docs/bridge-review.md).
- Cookie-authenticated writes are also refused when `Origin` is another site (CSRF hardening).

## Architecture

```
iPad PWA ─┐                         ┌─ Mac browser (side panel, follow iPad)
          │  IndexedDB (Dexie): entities + event log, works offline
          └──── POST /api/sync (push dirty, pull since cursor) ────┘
                          │
                Next.js on Vercel ── Neon Postgres (entities, events)
```

- **Entities** (`notebook`, `section`, `stroke`, `textbox`, `presence`) are small JSON docs stamped
  with a hybrid logical clock; last writer wins per entity. Nothing is hard-deleted.
- **Strokes** keep every input sample: x, y, pressure, altitude, azimuth, ms offset (`src/lib/types.ts`).
- **Events** are an append-only log (strokes, erases, undo, tool changes, section focus, zoom,
  visibility, copies) for analytics and AI review.
- **Ink**: `perfect-freehand` outlines, cached `Path2D`, tiled canvases per section that mount
  only near the viewport, and one overlay canvas for the in-progress stroke (coalesced and
  predicted pointer events).

## Roadmap

- Canvas import: list courses and files, then pull lecture PDFs, slides and problem sheets.
- PDF import with `pdf_crop` blocks (lecture excerpts placed in sections).
- Remote MCP server (`/api/mcp`) so Claude Code / Codex can read the current section and import payloads.
- Realtime ping (Ably / Neon Realtime) in place of the 2 s poll; timed tests; PDF export.

## Development

```bash
npm install
npm run dev        # http://localhost:3000; reach it from the iPad via your Mac's LAN IP
npm run build && npm run lint
npm test           # vitest: tokens, auth scoping, job queue (PGlite), bridge lib + end-to-end
npm run typecheck  # app + bridge
```
