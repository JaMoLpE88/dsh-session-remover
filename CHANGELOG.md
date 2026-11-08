# Changelog

All notable changes to `@jamolpe88/dsh-session-remover` are documented here.

## 0.1.2 — 2026-11-08

- Repository hygiene: neutralized an internal code-comment wording and added ignore rules. No functional changes.

## 0.1.1 — 2026-10-26

- **Fixed the boot crash** caused by the scoped package name: the Client bundle registered itself as `dsh-session-remover` while the package loads as `@jamolpe88/dsh-session-remover`, so the module loader saw a duplicate factory and the entry never activated. `client.js` now registers under the package name.
- `npm run check` now fails when the Client module id, the package name and the patch row disagree, so this cannot ship again.

## 0.1.0 — 2026-10-26

- First release.
- **Delete session** row in the sidebar session `⋯` menu, in red and placed after the shipped rows.
- Confirmation dialog that names the session, defaults focus to **Cancel**, closes on **Escape** and reports Host failures inline.
- Real removal of the local session: the JSONL session directory, its projection-cache record and its workspace references.
- Closes a live session through its own `AgentHandle` before touching storage, so the writer lease is released first; refuses to delete when that is not possible.
- Works with archived and pinned sessions: the archive marker and the pin are cleaned as part of deletion.
- Confirmation-only HTTP route behind the Host's own request fence; no agent tools, no commands, no settings page.
- English-only interface text.
