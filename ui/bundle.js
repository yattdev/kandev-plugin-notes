// kandev-plugin-notes UI bundle — the frontend half of this plugin.
//
// This is a hand-written, NO-BUILD plain-JS ES module. It ships byte-for-byte
// inside the package tar.gz under ui/bundle.js, and kandev serves it directly
// from the extracted package, then dynamically imports it as a native ES
// module. There is nothing to build: edit this file and repackage
// (`make package` / `make package-host`).
//
// The plugin: a per-user, private scratchpad note on a task.
//   - A task panel (registerTaskPanel, mobileEnabled) renders the note as
//     rich text (host.ui.RichTextEditor) and autosaves through host.storage.
//   - A kanban card menu action (registerTaskMenuAction, group "edit") opens
//     the same editor in a modal, bound to that card's own taskId.
//   - A task-card-indicators component shows a glyph when the task has a
//     non-empty note.
//
// The stateful logic (read guard, debounced write, conflict handling,
// subscribe wiring, indicator cache) is factored into framework-free
// functions below — no host.React, no DOM — so it is unit-testable with
// `node --test` against a fake host (see ui/bundle.test.mjs). This file adds
// `export` to those functions purely for that test import; the plugin still
// registers itself the normal way, via window.registerKandevPlugin at
// evaluation time. `id` below MUST match manifest.yaml's id.
//
// host.storage is per-user (capabilities.user_state) — every read/write is
// scoped to the calling user. This note is a private scratchpad, not a
// document shared by everyone on the task; the empty-state copy below says
// so explicitly.

const NOTE_SCOPE = "task";
const NOTE_KEY = "note";
const WRITE_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// createNoteStore — a single task's note, independent of any UI framework.
//
// Guards ported from docs/public/plugins-authoring.md recipe #3 ("Task panel
// with task-scoped Host state"):
//   - refresh() is guarded by a generation counter (not just a `disposed`
//     flag): two overlapping host.storage.get calls can resolve out of
//     order, and only the read matching the current generation may commit,
//     otherwise a stale response arriving after a newer one would win.
//   - updatedAt is tracked so every write's ifUnmodifiedSince matches the
//     most recent successful get/set (H1 optimistic concurrency).
//   - subscribe's writerId is this store's own surfaceId, not the host's
//     shared per-tab default — otherwise a second surface writing the same
//     note (the kanban modal vs. the task panel) would look like this
//     store's own echo and its write would never arrive here.
//   - a PluginStorageConflictError (409) stops the write queue, preserves
//     the caller's in-flight edit, and only refreshes the authoritative
//     updatedAt — it never silently discards the edit.
//   - setTaskId() clears value/updatedAt synchronously (before the new
//     task's read resolves) so a write in flight for the old task can never
//     be sent under the new task's id with a stale ifUnmodifiedSince.
// ---------------------------------------------------------------------------
export function createNoteStore(host, { taskId, surfaceId, onCommit }) {
  let currentTaskId = taskId;
  let value = "";
  let updatedAt;
  let loadedTaskId = null;
  let readError = false;
  let dirty = false;
  let conflict = false;
  let writeError = false;

  let pendingValue;
  let writeTimer;
  let writeInFlight = false;
  let writeBlocked = false;
  let writeGeneration = 0;
  let refreshGeneration = 0;
  let disposed = false;
  let unsubscribeStorage = null;

  const listeners = new Set();
  function notify() {
    listeners.forEach((listener) => listener());
  }

  function getSnapshot() {
    return {
      taskId: currentTaskId,
      value,
      loaded: loadedTaskId === currentTaskId,
      readError,
      conflict,
      writeError,
    };
  }

  // refresh() re-reads the note from host.storage. `preserveValue` (used on
  // conflict-retry) skips overwriting the caller's in-progress edit even
  // though the read itself must still succeed to refresh `updatedAt`.
  function refresh(options = {}) {
    const preserveValue = options.preserveValue ?? dirty;
    const generation = ++refreshGeneration;
    const forTaskId = currentTaskId;
    return host.storage.get(NOTE_SCOPE, forTaskId, NOTE_KEY).then(
      (entry) => {
        if (disposed || generation !== refreshGeneration || forTaskId !== currentTaskId) return false;
        if (!preserveValue && !dirty) value = entry ? entry.value : "";
        updatedAt = entry ? entry.updatedAt : undefined;
        loadedTaskId = forTaskId;
        readError = false;
        notify();
        return true;
      },
      () => {
        // Do not mark the task loaded after a rejected read: an empty
        // editor here could omit ifUnmodifiedSince on its first save and
        // silently overwrite an existing note. Stay in a retry state.
        if (disposed || generation !== refreshGeneration || forTaskId !== currentTaskId) return false;
        readError = true;
        notify();
        return false;
      },
    );
  }

  function subscribeStorage() {
    if (unsubscribeStorage) unsubscribeStorage();
    const forTaskId = currentTaskId;
    unsubscribeStorage = host.storage.subscribe(
      { scope: NOTE_SCOPE, scopeId: forTaskId, key: NOTE_KEY, writerId: surfaceId },
      () => refresh(),
    );
  }

  function resetWriteState() {
    writeGeneration++;
    pendingValue = undefined;
    writeInFlight = false;
    writeBlocked = false;
    conflict = false;
    writeError = false;
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    }
  }

  function setTaskId(nextTaskId) {
    if (nextTaskId === currentTaskId) return;
    currentTaskId = nextTaskId;
    value = "";
    updatedAt = undefined;
    loadedTaskId = null;
    readError = false;
    dirty = false;
    resetWriteState();
    notify();
    subscribeStorage();
    refresh();
  }

  function scheduleFlush(generation) {
    writeTimer = setTimeout(() => {
      if (writeGeneration !== generation) return;
      writeTimer = undefined;
      flushWrite();
    }, WRITE_DEBOUNCE_MS);
  }

  function scheduleWrite() {
    if (writeBlocked || writeTimer !== undefined) return;
    scheduleFlush(writeGeneration);
  }

  function flushWrite() {
    if (writeBlocked || writeInFlight || pendingValue === undefined) return;
    const generation = writeGeneration;
    const forTaskId = currentTaskId;
    const next = pendingValue;
    pendingValue = undefined;
    writeInFlight = true;
    host.storage
      .set(NOTE_SCOPE, forTaskId, NOTE_KEY, next, { writerId: surfaceId, ifUnmodifiedSince: updatedAt })
      .then((result) => {
        if (writeGeneration !== generation) return;
        updatedAt = result.updatedAt;
        dirty = pendingValue !== undefined;
        conflict = false;
        writeError = false;
        notify();
        // Own-tab echoes of this write are suppressed by the storage
        // subscription above (writerId matches), so the card-indicator
        // cache is updated directly rather than via a notification.
        if (onCommit) onCommit(next !== "");
      })
      .catch((error) => {
        if (writeGeneration !== generation) return;
        pendingValue = pendingValue ?? next;
        writeBlocked = true;
        if (error && error.name === "PluginStorageConflictError") {
          conflict = true;
          notify();
          refresh({ preserveValue: true });
          return;
        }
        writeError = true;
        notify();
      })
      .finally(() => {
        if (writeGeneration !== generation) return;
        writeInFlight = false;
        if (!writeBlocked && pendingValue !== undefined) {
          scheduleFlush(generation);
        }
      });
  }

  function setValue(next) {
    value = next;
    dirty = true;
    pendingValue = next;
    notify();
    scheduleWrite();
  }

  function retryRead() {
    return refresh();
  }

  function retryWrite() {
    return refresh({ preserveValue: true }).then((ok) => {
      if (!ok) return false;
      writeBlocked = false;
      conflict = false;
      writeError = false;
      notify();
      scheduleWrite();
      return true;
    });
  }

  function dispose() {
    disposed = true;
    if (unsubscribeStorage) unsubscribeStorage();
    resetWriteState();
    activeStores.delete(store);
  }

  const store = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    setValue,
    setTaskId,
    retryRead,
    retryWrite,
    dispose,
  };

  activeStores.add(store);
  subscribeStorage();
  refresh();
  return store;
}

// Every store created by initialize() while the plugin is enabled, so
// destroy() can dispose each one (unsubscribing and clearing its pending
// debounce timer) even if its owning component never got to unmount.
const activeStores = new Set();

// ---------------------------------------------------------------------------
// Card-indicator cache — module-level so it survives route navigation and is
// shared by every rendered card, per AC17: at most one host.storage.get per
// taskId per page session. A second render serves the cache; a cross-tab
// subscribe notification updates it from the notification's `deleted` flag
// alone (no refetch — the payload carries no value); and a successful local
// write updates it directly, since own-tab echoes of that write are
// suppressed by the writerId-scoped subscription above and would never
// reach this module-level listener otherwise.
//
// A cross-tab *non-delete* notification is optimistically treated as "has a
// note" without inspecting content, since PluginUserStateChange carries no
// value — a rare false positive (e.g. another tab writing an all-whitespace
// note) is an acceptable, documented approximation for avoiding a second
// network round trip per card.
// ---------------------------------------------------------------------------
const noteCache = new Map();
const pendingGets = new Map();
const cacheListeners = new Map();
let indicatorUnsubscribe = null;

function notifyCacheListeners(taskId) {
  const listeners = cacheListeners.get(taskId);
  if (!listeners) return;
  const hasNote = noteCache.get(taskId) ?? false;
  listeners.forEach((listener) => listener(hasNote));
}

export function markNote(taskId, hasNote) {
  noteCache.set(taskId, hasNote);
  notifyCacheListeners(taskId);
}

export function getCachedHasNote(host, taskId) {
  if (noteCache.has(taskId)) return Promise.resolve(noteCache.get(taskId));
  const pending = pendingGets.get(taskId);
  if (pending) return pending;

  const request = host.storage.get(NOTE_SCOPE, taskId, NOTE_KEY).then(
    (entry) => {
      pendingGets.delete(taskId);
      const hasNote = Boolean(entry && typeof entry.value === "string" && entry.value !== "");
      noteCache.set(taskId, hasNote);
      notifyCacheListeners(taskId);
      return hasNote;
    },
    () => {
      // Leave this taskId uncached on a failed read so a later render can
      // retry, instead of pinning it to a possibly-wrong false forever.
      pendingGets.delete(taskId);
      return false;
    },
  );
  pendingGets.set(taskId, request);
  return request;
}

export function subscribeCache(taskId, listener) {
  let listeners = cacheListeners.get(taskId);
  if (!listeners) {
    listeners = new Set();
    cacheListeners.set(taskId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cacheListeners.delete(taskId);
  };
}

// initNoteIndicatorSubscription is called from initialize() every time the
// plugin is (re-)enabled. It tears down any prior subscription first so
// calling initialize() twice in one tab (disable -> re-enable) still leaves
// exactly one module-level subscription, never two.
export function initNoteIndicatorSubscription(host) {
  if (indicatorUnsubscribe) indicatorUnsubscribe();
  indicatorUnsubscribe = host.storage.subscribe({ scope: NOTE_SCOPE, key: NOTE_KEY }, (change) => {
    markNote(change.scopeId, !change.deleted);
  });
}

export function disposeNoteIndicatorSubscription() {
  if (indicatorUnsubscribe) {
    indicatorUnsubscribe();
    indicatorUnsubscribe = null;
  }
  noteCache.clear();
  pendingGets.clear();
  cacheListeners.clear();
}

// ---------------------------------------------------------------------------
// makeNoteModalContent — the kanban "Edit notes" shortcut's modal body. Built
// fresh inside registerTaskMenuAction's run(context), closing over that
// specific card's taskId/taskTitle rather than reading any globally-active
// task or session id. This plugin talks to no agent/session at all, so
// PR #2050's wrong-session bug class (a kanban shortcut on a non-active task
// acting on the globally active session) cannot occur here — but the rule
// still applies to the one piece of task identity this plugin does use: every
// surface below keys off its own taskId/props.taskId, never a store-wide
// "current task".
// ---------------------------------------------------------------------------
export function makeNoteModalContent(host, taskId) {
  return function NoteModalContent() {
    const { jsx: h } = host;
    return h(NotesEditor, {
      host,
      taskId,
      surfaceId: "note-modal",
      presentation: "desktop",
      // host.ui.RichTextEditor (TipTapPlanEditor) calls useMermaidErrorToast,
      // which requires a ToastProvider ancestor. The host's own
      // PluginModalHost (components/plugins/plugin-modal-host.tsx) does not
      // render one, so mounting the rich editor here throws and the modal
      // body goes blank (title bar only) — a host-platform gap, not
      // something this plugin's own repo can fix. Fall back to a plain
      // textarea for this one surface until that's addressed upstream; the
      // task panel keeps the full rich editor, which does have a
      // ToastProvider ancestor.
      editorKind: "plain",
    });
  };
}

// ---------------------------------------------------------------------------
// React layer. Deliberately thin: all the guard logic above is framework-
// free and unit-tested directly; these components only subscribe to it.
// ---------------------------------------------------------------------------
function useNoteStore(host, { taskId, surfaceId }) {
  const React = host.React;
  const storeRef = React.useRef(null);
  const [snapshot, setSnapshot] = React.useState(null);

  React.useEffect(() => {
    const store = createNoteStore(host, {
      taskId,
      surfaceId,
      onCommit: (hasNote) => markNote(store.getSnapshot().taskId, hasNote),
    });
    storeRef.current = store;
    setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    return () => {
      unsubscribe();
      store.dispose();
      storeRef.current = null;
    };
    // surfaceId identifies the store; a taskId change while the same
    // surface stays mounted is handled by the effect below via
    // store.setTaskId(), not by recreating the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, surfaceId]);

  React.useEffect(() => {
    if (storeRef.current) storeRef.current.setTaskId(taskId);
  }, [taskId]);

  return { snapshot, store: storeRef.current };
}

function NotesEditor({ host, taskId, surfaceId, presentation, editorKind = "rich" }) {
  const { jsx: h, ui } = host;
  const { snapshot, store } = useNoteStore(host, { taskId, surfaceId });
  const isMobile = presentation === "mobile";
  const containerStyle = isMobile
    ? { display: "flex", flexDirection: "column", height: "100%", padding: "0.5rem" }
    : { display: "flex", flexDirection: "column", height: "100%", padding: "0.75rem" };

  if (!snapshot) {
    return h("div", { style: containerStyle }, "Loading notes…");
  }
  if (snapshot.readError) {
    return h(
      "div",
      { style: containerStyle },
      h("p", null, "Could not load this note."),
      h(
        "button",
        { type: "button", onClick: () => store.retryRead(), style: { cursor: "pointer" } },
        "Retry",
      ),
    );
  }
  if (!snapshot.loaded) {
    return h("div", { style: containerStyle }, "Loading notes…");
  }

  const status = snapshot.conflict
    ? h(
        "div",
        { role: "status" },
        "This note changed elsewhere. Your edit is preserved.",
        h(
          "button",
          { type: "button", onClick: () => store.retryWrite(), style: { cursor: "pointer" } },
          "Retry my edit",
        ),
      )
    : snapshot.writeError
      ? h(
          "div",
          { role: "status" },
          "Could not save this note.",
          h(
            "button",
            { type: "button", onClick: () => store.retryWrite(), style: { cursor: "pointer" } },
            "Retry",
          ),
        )
      : null;

  return h(
    "div",
    { style: containerStyle },
    h("p", { style: { color: "var(--muted-foreground)", fontSize: "0.8rem", marginBottom: "0.5rem" } },
      "Private to you — only you can see this note.",
    ),
    editorKind === "plain"
      ? h("textarea", {
          value: snapshot.value,
          onChange: (e) => store.setValue(e.target.value),
          placeholder: "Jot a note about this task…",
          className: "flex-1 min-h-0",
          style: { resize: "none", width: "100%" },
          "data-testid": "notes-modal-editor",
        })
      : h(ui.RichTextEditor, {
          taskId,
          value: snapshot.value,
          onChange: (next) => store.setValue(next),
          placeholder: "Jot a note about this task…",
          className: isMobile ? "flex-1 min-h-0" : "flex-1 min-h-0",
          testId: "notes-panel-editor",
        }),
    status,
  );
}

function makeNotesPanelComponent(host) {
  return function NotesPanel({ taskId, panelId, presentation }) {
    return host.jsx(NotesEditor, { host, taskId, surfaceId: panelId, presentation });
  };
}

function bookGlyph(h) {
  // Inline SVG — this bundle ships no build step and cannot import an icon
  // set. Matches the curated "book" icon used for the panel's own tab.
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: 12,
      height: 12,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    h("path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }),
    h("path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }),
  );
}

function useNoteIndicator(host, taskId) {
  const React = host.React;
  const [hasNote, setHasNote] = React.useState(() => noteCache.get(taskId) ?? false);

  React.useEffect(() => {
    if (!taskId) return undefined;
    let cancelled = false;
    getCachedHasNote(host, taskId).then((value) => {
      if (!cancelled) setHasNote(value);
    });
    const unsubscribe = subscribeCache(taskId, (value) => {
      if (!cancelled) setHasNote(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host, taskId]);

  return hasNote;
}

function makeCardIndicatorComponent(host) {
  return function NoteCardIndicator({ slotProps }) {
    const taskId = (slotProps && slotProps.taskId) || null;
    const hasNote = useNoteIndicator(host, taskId);
    if (!taskId || !hasNote) return null;
    return host.jsx(
      "span",
      {
        "data-testid": "notes-card-indicator",
        title: "Has a private note",
        "aria-label": "Has a private note",
        style: { display: "inline-flex", alignItems: "center" },
      },
      bookGlyph(host.jsx),
    );
  };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------
window.registerKandevPlugin("kandev-plugin-notes", {
  initialize(registry, host) {
    initNoteIndicatorSubscription(host);

    registry.registerTaskPanel({
      id: "notes",
      title: "Notes",
      icon: "book",
      Component: makeNotesPanelComponent(host),
      mobileEnabled: true,
    });

    registry.registerComponent("task-card-indicators", makeCardIndicatorComponent(host));

    registry.registerTaskMenuAction({
      id: "edit-notes",
      label: "Edit notes",
      icon: host.jsx(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        host.jsx("path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }),
        host.jsx("path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }),
      ),
      group: "edit",
      visible: (context) => Boolean(context.taskId),
      run: (context) => {
        host.openModal({
          title: `Edit notes — ${context.taskTitle}`,
          content: makeNoteModalContent(host, context.taskId),
          size: "lg",
        });
      },
    });
  },

  destroy() {
    disposeNoteIndicatorSubscription();
    activeStores.forEach((store) => store.dispose());
    activeStores.clear();
  },
});
