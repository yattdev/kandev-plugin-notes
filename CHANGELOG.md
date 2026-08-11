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

- The `agent_unavailable` enhance failure no longer names Settings > Plugins >
  Notes. That code means the plugin could not identify the cause, so naming a
  page was a guess — and it sent users who had already completed that step
  back to it. It now quotes the host's own wording instead. Reachable today by
  selecting and enabling an agent while leaving its model/profile unbound
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

