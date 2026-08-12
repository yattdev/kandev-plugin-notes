# Changelog

## [0.3.0] - 2026-08-11

### Added

- feat: per-workspace notes — a sidebar button (registered for the host's
  `sidebar-workspace-actions` slot, inert on hosts without it) opens the same
  note editor/modal scoped to the active workspace instead of a task
- feat: Enhance with AI now returns a stable, machine-readable failure code
  (unset/missing/disabled/unavailable) and a guided-setup action button that
  jumps to the correct settings page instead of one message for every cause

### Changed

- `createNoteStore` and the card-indicator cache are now scope-generic
  (`scope`/`scopeId` instead of a hardcoded "task"); existing task callers are
  unaffected (`taskId` remains a working alias)

### Fixed

- Enhance with AI now recognizes a fifth state: an agent that is selected and
  enabled but has **no model or agent profile bound** — the state every
  built-in utility agent ships in, and therefore what most people hit right
  after following the documented two-step setup. It gets its own
  `agent_unconfigured_profile` code and a "Finish setting up the agent" button
  pointing at Settings > Utility Agents. Previously it fell through to
  `agent_unavailable`, whose message sent the user back to Settings > Plugins >
  Notes — the step they had just completed correctly
- `agent_unavailable` now means only "a cause this plugin could not identify".
  It names no settings page (any page would be a guess) and quotes the host's
  own wording instead
- The workspace note editor no longer shows the task-scoped placeholder
  ("Jot a note about this task…") under a modal titled "Workspace notes"

## [0.2.3] - 2026-08-11

### Changed

- Update README.md to add demo screencast (5dabfdc)


## [0.2.2] - 2026-08-10

### Changed

- fix: diagnose and surface note read failures instead of a dead retry loop (a06ec3f)


## [0.2.1] - 2026-08-10

### Changed

- fix: hide dead comment button on rich editor; add modal preview toggle (6598d95)
- Use host.ui.RichTextEditor for the notes panel, matching the Plan editor (a6f59cd)
- Add checklist (GFM task-list) toolbar button (1d760d6)
- ci: tidy go.mod to promote direct grpc dependency (0ed27c4)
- qa: handle list toolbar on blank notes (a1c18cd)
- feat: markdown toolbar, AI-assisted proofreading, and a fixed-size note modal (4c84eb9)

