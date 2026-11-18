# Chat revamp (2026-11-18)

Follows `docs/chat-panel-2026-11-17.md`; only the changes are listed here.

## Logins and models come from the Mac

`bridge/catalog.ts` reads, on start-up and every 5 minutes:

- **Claude**: `~/.claude/cache/model-catalog/*.json` (the `cc` surface first, newest first), the
  login email from `~/.claude.json`. Models in section `main` are listed first; the rest go under
  "More models". Without a cache it falls back to the opus / sonnet / fable / haiku aliases.
- **Codex**: every `~/.codex` and `~/.codex_<name>` folder that has an `auth.json` (folders ending in
  `_backup` are skipped), plus `codexHomes` from `bridge.json`. For each: `models_cache.json`
  (`visibility: "list"`, by `priority`, with each model's reasoning levels), the top-level
  `model` / `model_reasoning_effort` of `config.toml`, and the email and plan from the id token's
  claims. Tokens are never read beyond that and never sent.

The account id is the folder name without the dot (`codex`, `codex_personal`, `codex_work`).
The bridge posts the accounts to `POST /api/bridge/catalog` only when they change (in the
background, so a slow server never delays a job). The server keeps them on the device token
(`device_tokens.catalog`); `GET /api/chat/catalog` returns the newest. A bridge older than 0.3.0
sends nothing and the picker shows its built-in list.

`ChatOptions.account` (and `jobOptionsSchema.account`) names the login. For a Codex job the bridge
looks it up among the homes it found and runs Codex with `CODEX_HOME` set to it; an unknown account
fails the turn with a message instead of quietly using another login's limits. The thread's saved
session records the account, and a turn on another account starts fresh from `history.md`
(a Codex session lives in one `CODEX_HOME`).

## UI

- **Composer**: one rounded card. Attach (+), the context chip, **Search** and **Code** toggles, the
  model picker and a round Send button that turns into Stop while a reply runs and the box is
  empty. Drag-and-drop shows an overlay.
- **Model picker**: grouped by login (label and email), search, "More models", context size and
  badges, an Effort row limited to what the chosen model supports (Auto = model default), and an
  "Other" field for any model id. Choosing a model drops an effort the new model lacks.
- **Context**: "This section" is the section the iPad is on while the iPad is in this notebook
  (`focusedSection`), else the Mac's current section. The chip names it; the popover holds the
  scopes, the content toggles and the exact preview.
- **Tools**: web search and code are on by default (`toolsOf`: on unless the thread set them to
  false). Code needs the writable job folder, so it turns edits on for that turn.
- **New chat**: goes to an untouched chat of this notebook if there is one (`reusableThread`),
  else makes one with the last-used model and tools (`padsync.chat.defaults`).
- **Sidebar**: New chat, search, This notebook / All / Archived, chats grouped as Pinned, Today,
  Yesterday, Previous 7 days, Previous 30 days, Older; row menu on hover. Its collapsed state is
  remembered. The narrow (drawing) layout puts the list in a dropdown on the title.
- **Messages**: your messages as right-aligned bubbles with hover Edit / Copy; replies as open prose
  with the model name, typing dots while waiting, a caret while streaming, hover Copy /
  Regenerate, and a copy button on each code block. The empty state offers starter prompts.
