# kandev-plugin-notes

A [Kandev](https://github.com/kdlbs/kandev) plugin that gives every task a
private markdown notes scratchpad, edited with a rich, Plan-panel-style
editor and optional AI-assisted proofreading.

## Demo

[Screencast from 2026-08-10 20-08-31.webm](https://github.com/user-attachments/assets/65078214-dae5-4f71-a125-cb5863bc420f)


## What it does

- **Notes task panel** — a dockview panel in the task workspace (`+` → Notes),
  also available on a phone under the grouped **Panels** bottom-nav action.
  It renders `host.ui.RichTextEditor`, the same TipTap-based WYSIWYG editor
  the Plan panel uses: bold, italic, headings, bullet/numbered lists, links,
  code blocks, and GFM checklists are all reachable through its selection
  bubble menu and "/" slash commands — markdown in, markdown out, no
  separate toolbar needed (the Plan panel has none either). Content
  autosaves through host.storage, debounced.

  The selection bubble menu also shows a purple "comment" icon inherited
  from the Plan editor's internals — it is always rendered by
  `TipTapPlanEditor` regardless of whether a caller wires up
  `onSelectionChange`, and `host.ui.RichTextEditor`'s narrow plugin-facing
  contract never does. Clicking it is a host-platform no-op for every
  plugin that uses `host.ui.RichTextEditor`, not just this one, and there is
  no prop to disable it — so this plugin hides it with a small scoped CSS
  rule injected at startup (see `injectPluginStyles` in `ui/bundle.js`)
  rather than shipping a dead button.
- **Kanban shortcut** — `Edit > Edit notes` on a kanban card opens the note
  in a fixed-size modal — the modal itself never grows as you type; the
  editor scrolls internally instead. The modal uses a markdown `<textarea>`
  with its own formatting toolbar (bold, italic, heading, bullet/numbered/
  checklist lists, link, inline code, code block) rather than the rich
  editor: `host.ui.RichTextEditor` depends on a `ToastProvider` ancestor
  that the host's plugin-modal surface doesn't provide, so it cannot mount
  there (a host-platform gap, not something this plugin can fix). The
  toolbar's actions insert or wrap the right markdown around your current
  selection (or at the caret) so you never have to remember the syntax —
  including GFM task-list checkboxes (`- [ ] `) via the checklist button.

  A **Preview** toggle next to "Enhance with AI" swaps the textarea for a
  read-only rendered view of the same markdown (`host.ui.RichTextReadOnly`,
  the Plan editor's read-only renderer) — headings, lists, checkboxes, code
  blocks, and links rendered as they'll actually look, without the
  `ToastProvider` dependency that blocks the fully-editable rich editor in
  a modal. Checkboxes render but aren't clickable in Preview (the
  underlying TipTap node view is read-only); toggle back to Edit to check
  them off via the checklist syntax instead.

- **Enhance with AI** — a button next to the toolbar/editor sends the note's
  current markdown to your configured utility agent to proofread grammar,
  spelling, and clarity. The result is shown as a preview with
  **Accept**/**Discard** before it ever replaces your note — nothing is
  overwritten automatically. See "Notes are private to you" below for the
  privacy trade-off this makes.
- **Card indicator** — a small glyph on cards that have a note.
- **Workspace notes** — a small book icon beside Quick Terminal and Quick Chat
  in the sidebar's New Task row (on a host build that carries the
  `sidebar-workspace-actions` slot) opens the same editor, modal, toolbar,
  Preview, and Enhance with AI included, scoped to the active **workspace**
  instead of a task. Use it for a half-formed idea or a reminder that isn't
  worth creating a task to hold. The icon is muted when the workspace has no
  note and full-contrast once it does, and flips live (no reload) as the note
  is written, emptied, or edited from another tab. A task's note and its
  workspace's note are stored and shown independently; the icon is not
  rendered without an active workspace.
- **Cross-tab sync** — an edit in one tab shows up in another without a reload.

## If a note won't load

Both entry points (the task panel and the kanban "Edit notes" shortcut) read
the note through the same store, so a load failure looks the same everywhere:
a short message plus a muted detail line and a **Retry** button, instead of
the editor. The message tells you what to do next:

- **"Your session could not be verified."** / **"...storage access is
  disabled..."** — not retried automatically; reload the page, or ask an
  admin to check the plugin's capabilities under Settings > Plugins.
- **"The server had a problem loading this note."** / **"Could not reach the
  server..."** — retried automatically (up to 3 attempts with backoff)
  before falling back to the manual Retry button.
- Anything else — a generic message with the raw detail underneath; use
  Retry, and if it persists, that detail line is what to include in a bug
  report.

Typing is disabled while a note fails to load — an empty editor here could
otherwise save over an existing note the read never actually saw.

## Notes are private to you — except when you ask AI to enhance one

Each note is stored per **user**, per **task or workspace** (whichever you
opened), under the plugin's own key (`(scope, id, "note")`, `scope` being
`"task"` or `"workspace"`) via Kandev's per-user plugin storage
(`capabilities.user_state`). Two people looking at the same task or workspace
each see their own note; nobody else can read yours, and no task's agent can
read or write it.

**The one exception is the "Enhance with AI" button.** Clicking it sends the
note's current markdown to the utility agent configured for this plugin
(**Settings > Plugins > Notes**) via a one-shot completion
(`capabilities.agent_invoke` / `Host.InvokeUtilityAgent`) — that content
leaves the "nobody else can read it" boundary for that one request. See
"Setting up Enhance with AI" below for what has to be configured first, and
what each failure message means. Skip the button entirely to keep a note
fully private.

If you want a task's own agent to see something, put it in the task
description or say it in chat. This is a scratchpad, not a shared field.

## Setting up Enhance with AI

"Enhance with AI" needs **two separate settings**, both satisfied, before it
can run:

1. **Select an agent for this plugin** — Settings > Plugins > Notes,
   `config_schema.utility_agent`. This is what tells the plugin which
   utility agent to ask.
2. **Enable that agent, with a model** — Settings > Utility Agents. Selecting
   an agent in step 1 does not enable it; a newly-added utility agent starts
   disabled with no model chosen.

Both steps are required because **a disabled utility agent is usable by
kandev's own built-in features (e.g. task-create prompt enhancement) but not
by any plugin**, including this one. Kandev's own prompt-enhancement path
does not check `Enabled`; this plugin's request goes through
`Host.InvokeUtilityAgent`, which does. That asymmetry is host behavior this
plugin cannot change — clicking Enhance with an agent selected-but-disabled
fails exactly like having no agent selected at all, and the two failures now
say so explicitly rather than both pointing back at Settings > Plugins > Notes:

| Situation | Message points you to |
| --- | --- |
| No agent ever selected | Settings > Plugins > Notes |
| Selected agent was since deleted | Settings > Plugins > Notes |
| Selected agent exists but is disabled | **Settings > Utility Agents** ("Enable the agent") |
| Selected and enabled, but no model / agent profile bound | **Settings > Utility Agents** ("Finish setting up the agent") |
| Any other setup problem the plugin can't identify | no page named; the host's own wording is quoted instead |
| A real execution failure (the agent ran and failed) | no settings link — try again |

For the first four, **Dismiss** is joined by a second action button that
jumps straight to the right page for that cause, so there's no need to guess
which setting is missing.

The fourth row is the one most people hit, because **every built-in utility
agent ships with no model bound**: completing steps 1 and 2 above still leaves
it unconfigured. It is called out separately from "disabled" on purpose —
both are fixed on the same page but by different controls, and being told to
enable an agent you just enabled is the dead end this plugin exists to avoid.

The fifth row is the honest fallback: a `FailedPrecondition` this plugin does
not recognize (for example after a host rephrase). It names no page, because
any page it named would be a guess, and quotes the host's own wording instead.

## Install

Until the first release is published, install by sideload — build a package and
upload it through **Settings > Plugins > Install plugin**, or:

```sh
make package-host
curl -F "package=@kandev-plugin-notes-<version>.tar.gz" \
  http://localhost:<kandev-port>/api/plugins/install
```

Sideloaded plugins register disabled/unverified; enable it in
**Settings > Plugins**. Reinstalling the same version returns 409 — bump the
version in `manifest.yaml` (and `Makefile`) first. To use "Enhance with AI",
see "Setting up Enhance with AI" above — it's a two-step setup, not one.

## Development

The Kandev plugin SDK (`pkg/pluginsdk`) is not yet published as a standalone Go
module, so `go.mod` uses a local `replace` that expects the Kandev monorepo as a
**sibling checkout**:

```text
some-dir/
├── kandev/                 # https://github.com/kdlbs/kandev — Go module at apps/backend/
└── kandev-plugin-notes/    # this repo
```

```sh
make build   # host binary
make test    # Go + JS unit tests
make vet
make package-host   # host-platform package — fastest local loop
make package        # all five platforms
```

Start with the [plugin authoring guide](https://github.com/kdlbs/kandev/blob/main/docs/public/plugins-authoring.md)
and the [manifest reference](https://github.com/kdlbs/kandev/blob/main/docs/public/plugins-manifest.md).

## License

MIT — see [LICENSE](LICENSE).


The Kandev plugin SDK (`pkg/pluginsdk`) is not yet published as a standalone Go
module, so `go.mod` uses a local `replace` that expects the Kandev monorepo as a
**sibling checkout**:

```text
some-dir/
├── kandev/                 # https://github.com/kdlbs/kandev — Go module at apps/backend/
└── kandev-plugin-notes/    # this repo
```

```sh
make build   # host binary
make test    # Go + JS unit tests
make vet
make package-host   # host-platform package — fastest local loop
make package        # all five platforms
```

Start with the [plugin authoring guide](https://github.com/kdlbs/kandev/blob/main/docs/public/plugins-authoring.md)
and the [manifest reference](https://github.com/kdlbs/kandev/blob/main/docs/public/plugins-manifest.md).

## License

MIT — see [LICENSE](LICENSE).
