# kandev-plugin-notes

A [Kandev](https://github.com/kdlbs/kandev) plugin that gives every task a
private, rich-text notes scratchpad.

> **Status: in development.** This commit bootstraps the repository. The plugin
> itself is not implemented yet.

## What it will do

- **Notes task panel** — a dockview panel in the task workspace (`+` → Notes),
  also available on a phone under the grouped **Panels** bottom-nav action.
  Rich-text editing (headings, lists, code blocks) via the host's own tiptap
  editor, with debounced autosave.
- **Kanban shortcut** — `Edit > Edit notes` on a kanban card opens the same
  editor in a modal, so you can jot something down without opening the task.
- **Card indicator** — a small glyph on cards that have a note.
- **Cross-tab sync** — an edit in one tab shows up in another without a reload.

## Notes are private to you

Each note is stored per **user**, per **task**, under the plugin's own key
(`("task", <taskId>, "note")`) via Kandev's per-user plugin storage
(`capabilities.user_state`). Two people looking at the same task each see their
own note; nobody else can read yours, and the agent cannot read or write it.

If you want the agent to see something, put it in the task description or say it
in chat. This is a scratchpad, not a shared field.

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
version in `manifest.yaml` (and `Makefile`) first.

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
