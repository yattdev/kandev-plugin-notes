# kandev-plugin-notes

A [Kandev](https://github.com/kdlbs/kandev) plugin that gives every task a
private markdown notes scratchpad, with a formatting toolbar and optional
AI-assisted proofreading.

## What it does

- **Notes task panel** — a dockview panel in the task workspace (`+` → Notes),
  also available on a phone under the grouped **Panels** bottom-nav action.
- **Markdown editing with a formatting toolbar** — a scrollable markdown
  `<textarea>` (bold, italic, headings, bullet/numbered lists, links, inline
  code, and code blocks), shared byte-for-byte by the task panel and the
  kanban modal, with debounced autosave. The toolbar's actions insert or wrap
  the right markdown around your current selection (or at the caret) so you
  never have to remember the syntax.
- **Enhance with AI** — a button next to the toolbar sends the note's current
  markdown to your configured utility agent to proofread grammar, spelling,
  and clarity. The result is shown as a preview with **Accept**/**Discard**
  before it ever replaces your note — nothing is overwritten automatically.
  See "Notes are private to you" below for the privacy trade-off this makes.
- **Kanban shortcut** — `Edit > Edit notes` on a kanban card opens the same
  editor (toolbar, AI button included) in a fixed-size modal — the modal
  itself never grows as you type; the editor scrolls internally instead.
- **Card indicator** — a small glyph on cards that have a note.
- **Cross-tab sync** — an edit in one tab shows up in another without a reload.

## Notes are private to you — except when you ask AI to enhance one

Each note is stored per **user**, per **task**, under the plugin's own key
(`("task", <taskId>, "note")`) via Kandev's per-user plugin storage
(`capabilities.user_state`). Two people looking at the same task each see their
own note; nobody else can read yours, and the agent working the task cannot
read or write it.

**The one exception is the "Enhance with AI" button.** Clicking it sends the
note's current markdown to the utility agent configured for this plugin
(**Settings > Plugins > Notes**) via a one-shot completion
(`capabilities.agent_invoke` / `Host.InvokeUtilityAgent`) — that content
leaves the "nobody else can read it" boundary for that one request. If no
utility agent is configured, the button shows a clear, non-fatal message
instead of failing silently. Skip the button entirely to keep a note fully
private.

If you want the task's own agent to see something, put it in the task
description or say it in chat. This is a scratchpad, not a shared field.

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
also pick a utility agent for this plugin under **Settings > Plugins > Notes**
(`config_schema.utility_agent`) — without one, the button surfaces a
not-configured message rather than failing.

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
