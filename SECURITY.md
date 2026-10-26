# Security

## What the plugin touches

- The Host half registers one route, `POST /plugins/session-remover/delete`, which
  the Client half calls from the Harness page.
- That route deletes exactly one session's own storage: its directory inside the
  JSONL session store, its projection-cache record and its workspace references.
- The plugin has no settings page, no config file, no network access and no
  telemetry.

## Destructive operations

- A request must pass the Host's own request fence **and** carry the
  `x-session-remover-confirmation` header. A link, an HTML form or a cross-site
  request cannot produce that header.
- The session id is validated against `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` before
  it can name a path.
- The resolved directory must be exactly `<session store root>/<one project
  segment>/<session id>`, must be a real directory (not a symlink) and must
  contain a session log file, or nothing is deleted.
- A live session is closed through its own `AgentHandle` first, and the plugin
  refuses to delete when the agent cannot be closed. Nothing is removed while the
  writer lease may still be held.
- The confirmation dialog names the target session; cancelling sends no request.

## Network

None. The plugin never leaves the machine and adds no outbound request.

## Reporting a vulnerability

Please use a private security advisory on the GitHub repository rather than a
public issue. Include the affected version, the impact and the smallest
reproduction you can.
