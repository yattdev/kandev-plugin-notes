// kandev-plugin-notes UI bundle — the frontend half of this plugin.
//
// This is a hand-written, NO-BUILD plain-JS ES module. It ships byte-for-byte
// inside the package tar.gz under ui/bundle.js, and kandev serves it directly
// from the extracted package, then dynamically imports it as a native ES
// module. There is nothing to build: edit this file and repackage
// (`make package` / `make package-host`).
//
// The plugin: a per-user, private scratchpad note on a task, edited as
// markdown through one shared editor on both surfaces:
//   - A task panel (registerTaskPanel, mobileEnabled) and
//   - a kanban card menu action (registerTaskMenuAction, group "edit") that
//     opens the same editor in a modal, bound to that card's own taskId.
//   Both render a scrollable markdown `<textarea>` with a formatting
//   toolbar (bold/italic/heading/lists/link/code) above it, and autosave
//   through host.storage. This editor intentionally does not use
//   host.ui.RichTextEditor (see makeNoteModalContent's history below for
//   why the modal surface could never use it) — one markdown editor keeps
//   both surfaces byte-identical and needs no host WYSIWYG dependency.
//   - A task-card-indicators component shows a glyph when the task has a
//     non-empty note.
//   - An "Enhance with AI" button (both surfaces) sends the note's current
//     markdown to this plugin's own `enhance` webhook
//     (server/plugin.go -> Host.InvokeUtilityAgent) and previews the
//     proofread result with Accept/Discard before it ever touches the
//     stored note.
//
// The stateful logic (read guard, debounced write, conflict handling,
// subscribe wiring, indicator cache, markdown transforms, the enhance
// preview state machine) is factored into framework-free functions below —
// no host.React, no DOM — so it is unit-testable with `node --test` against
// a fake host (see ui/bundle.test.mjs). This file adds `export` to those
// functions purely for that test import; the plugin still registers itself
// the normal way, via window.registerKandevPlugin at evaluation time. `id`
// below MUST match manifest.yaml's id.
//
// host.storage is per-user (capabilities.user_state) — every read/write is
// scoped to the calling user. This note is a private scratchpad, not a
// document shared by everyone on the task; the empty-state copy below says
// so explicitly. AI enhance is the one documented exception to "the agent
// cannot read your note": clicking it sends the note's current markdown to
// the operator-configured utility agent (README's Privacy section explains
// this trade-off).

const NOTE_SCOPE = "task";
const NOTE_KEY = "note";
const WRITE_DEBOUNCE_MS = 150;
const ENHANCE_WEBHOOK_PATH = "webhooks/enhance";

// ---------------------------------------------------------------------------
// Markdown transforms — pure functions, no DOM. Each takes the textarea's
// full value and its current selection (selStart === selEnd when there is
// no selection, i.e. just a caret) and returns { value, selStart, selEnd }:
// the new textarea value plus the selection the toolbar action's caller
// should apply afterwards (`textarea.setSelectionRange(selStart, selEnd)`),
// so a formatting action either wraps the user's existing selection or
// inserts a sensible placeholder that is itself selected for immediate
// overtyping (e.g. bold/italic/link).
// ---------------------------------------------------------------------------

// wrapSelection is the shared "before + selection(or placeholder) + after"
// transform behind bold/italic/inline-code: the wrapped text stays selected
// afterwards so a second click toggles it back to plain text intuitively.
function wrapSelection(text, selStart, selEnd, before, after, placeholder) {
  const hasSelection = selEnd > selStart;
  const inner = hasSelection ? text.slice(selStart, selEnd) : placeholder;
  const value = text.slice(0, selStart) + before + inner + after + text.slice(selEnd);
  const newSelStart = selStart + before.length;
  return { value, selStart: newSelStart, selEnd: newSelStart + inner.length };
}

export function applyBold(text, selStart, selEnd) {
  return wrapSelection(text, selStart, selEnd, "**", "**", "bold text");
}

export function applyItalic(text, selStart, selEnd) {
  return wrapSelection(text, selStart, selEnd, "*", "*", "italic text");
}

export function applyInlineCode(text, selStart, selEnd) {
  return wrapSelection(text, selStart, selEnd, "`", "`", "code");
}

export function applyCodeBlock(text, selStart, selEnd) {
  const hasSelection = selEnd > selStart;
  const inner = hasSelection ? text.slice(selStart, selEnd) : "code";
  const before = "```\n";
  const after = "\n```";
  const value = text.slice(0, selStart) + before + inner + after + text.slice(selEnd);
  const newSelStart = selStart + before.length;
  return { value, selStart: newSelStart, selEnd: newSelStart + inner.length };
}

// applyLink wraps the selection (or a placeholder) as link text and appends
// a `(url)` placeholder, then selects the url placeholder — so the very
// next thing the user types replaces "https://" rather than the link text.
export function applyLink(text, selStart, selEnd) {
  const hasSelection = selEnd > selStart;
  const linkText = hasSelection ? text.slice(selStart, selEnd) : "link text";
  const urlPlaceholder = "https://";
  const insertText = `[${linkText}](${urlPlaceholder})`;
  const value = text.slice(0, selStart) + insertText + text.slice(selEnd);
  const urlStart = selStart + `[${linkText}](`.length;
  return { value, selStart: urlStart, selEnd: urlStart + urlPlaceholder.length };
}

// lineBounds returns the [start, end) character range of the line
// containing `pos` (end excludes the trailing newline, matching how a
// textarea reports lines).
function lineBounds(text, pos) {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const nextBreak = text.indexOf("\n", pos);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return { start, end };
}

// lineRangeBounds extends lineBounds to cover every line touched by a
// selection, so a multi-line selection toggles/prefixes every line, not
// just the first.
function lineRangeBounds(text, selStart, selEnd) {
  const first = lineBounds(text, selStart);
  const last = lineBounds(text, Math.max(selEnd - 1, selStart));
  return { start: first.start, end: last.end };
}

// applyHeading toggles a Markdown ATX heading (default level 2) on the
// line containing the caret/selection start: applying the same level again
// removes it; applying while a different level is present replaces it.
export function applyHeading(text, selStart, selEnd, level = 2) {
  const { start, end } = lineBounds(text, selStart);
  const line = text.slice(start, end);
  const prefix = "#".repeat(level) + " ";
  const existing = line.match(/^(#{1,6})\s+/);
  let newLine;
  let delta;
  if (existing && existing[1].length === level) {
    newLine = line.slice(existing[0].length);
    delta = -existing[0].length;
  } else if (existing) {
    newLine = prefix + line.slice(existing[0].length);
    delta = prefix.length - existing[0].length;
  } else {
    newLine = prefix + line;
    delta = prefix.length;
  }
  const value = text.slice(0, start) + newLine + text.slice(end);
  return {
    value,
    selStart: Math.max(start, selStart + delta),
    selEnd: Math.max(start, selEnd + delta),
  };
}

// applyBulletList / applyNumberedList toggle a list marker on every
// non-blank line the selection touches. Toggling off requires every
// non-blank line to already carry the marker; otherwise the action adds it
// to whichever lines are missing it (so a partially-listified block
// converges to "all listified" in one click, the common editor idiom).
export function applyBulletList(text, selStart, selEnd) {
  const { start, end } = lineRangeBounds(text, selStart, selEnd);
  const block = text.slice(start, end);
  if (selStart === selEnd && block.trim() === "") {
    const marker = "- ";
    const value = text.slice(0, start) + marker + block + text.slice(end);
    return { value, selStart: selStart + marker.length, selEnd: selEnd + marker.length };
  }
  const lines = block.split("\n");
  const bulletRe = /^-\s+/;
  const allBulleted = lines.every((l) => bulletRe.test(l) || l.trim() === "");
  const newLines = lines.map((l) => {
    if (l.trim() === "") return l;
    if (allBulleted) return l.replace(bulletRe, "");
    return bulletRe.test(l) ? l : `- ${l}`;
  });
  const newBlock = newLines.join("\n");
  const value = text.slice(0, start) + newBlock + text.slice(end);
  const deltaFirstLine = newLines[0].length - lines[0].length;
  const deltaTotal = newBlock.length - block.length;
  return {
    value,
    selStart: Math.max(start, selStart + deltaFirstLine),
    selEnd: Math.max(start, selEnd + deltaTotal),
  };
}

export function applyNumberedList(text, selStart, selEnd) {
  const { start, end } = lineRangeBounds(text, selStart, selEnd);
  const block = text.slice(start, end);
  if (selStart === selEnd && block.trim() === "") {
    const marker = "1. ";
    const value = text.slice(0, start) + marker + block + text.slice(end);
    return { value, selStart: selStart + marker.length, selEnd: selEnd + marker.length };
  }
  const lines = block.split("\n");
  const numberRe = /^\d+\.\s+/;
  const allNumbered = lines.every((l) => numberRe.test(l) || l.trim() === "");
  let n = 0;
  const newLines = lines.map((l) => {
    if (l.trim() === "") return l;
    if (allNumbered) return l.replace(numberRe, "");
    n += 1;
    return numberRe.test(l) ? l : `${n}. ${l}`;
  });
  const newBlock = newLines.join("\n");
  const value = text.slice(0, start) + newBlock + text.slice(end);
  const deltaFirstLine = newLines[0].length - lines[0].length;
  const deltaTotal = newBlock.length - block.length;
  return {
    value,
    selStart: Math.max(start, selStart + deltaFirstLine),
    selEnd: Math.max(start, selEnd + deltaTotal),
  };
}

// ---------------------------------------------------------------------------
// enhanceNote — the "Enhance with AI" client. POSTs the note's current
// markdown to this plugin's own `enhance` webhook (server/plugin.go), which
// relays it through Host.InvokeUtilityAgent. host.api.fetch resolves to a
// plain fetch Response (see apps/web/lib/plugins/host-api.ts) — it does not
// throw on a non-2xx status, so every failure path here is driven by
// response.ok / response.status, mirroring the "enhance prompt" feature's
// own error handling.
// ---------------------------------------------------------------------------
export async function enhanceNote(host, content) {
  let response;
  try {
    response = await host.api.fetch(ENHANCE_WEBHOOK_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    const error = new Error("Could not reach the AI enhance service. Check your connection and try again.");
    error.notConfigured = false;
    throw error;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    // 412 is this webhook's distinguishable "no utility agent configured"
    // signal (server/plugin.go, mapped from gRPC FailedPrecondition per
    // ADR 0048) — surfaced as a clear, non-fatal message rather than a
    // generic failure.
    const notConfigured = response.status === 412;
    const message = notConfigured
      ? (data && data.error) || "No utility agent is configured for this plugin yet."
      : (data && data.error) || `Could not enhance this note (status ${response.status}).`;
    const error = new Error(message);
    error.notConfigured = notConfigured;
    error.status = response.status;
    throw error;
  }

  if (!data || typeof data.content !== "string") {
    const error = new Error("The AI enhance service returned an unexpected response.");
    error.notConfigured = false;
    throw error;
  }
  return data.content;
}

// ---------------------------------------------------------------------------
// enhancePreviewReducer — the "Enhance with AI" preview/Accept/Discard state
// machine, framework-free so it is unit-testable directly (no DOM, no
// host.React). NotesEditor wires this via host.React.useReducer:
//   idle -> (click Enhance) -> loading -> (success) -> preview -> (Accept
//   or Discard) -> idle. A failure from `loading` goes to `error` (message
//   shown inline, no note mutation); dismissing an error returns to idle.
// The note's stored value is only ever mutated by the component's own
// Accept handler (store.setValue), never by the reducer itself — this
// state machine only tracks what the preview UI should show.
// ---------------------------------------------------------------------------
export const initialEnhanceState = { status: "idle" };

export function enhancePreviewReducer(state, action) {
  switch (action.type) {
    case "start":
      return { status: "loading" };
    case "success":
      return { status: "preview", preview: action.content };
    case "failure":
      return { status: "error", message: action.message, notConfigured: Boolean(action.notConfigured) };
    case "discard":
    case "accept":
    case "dismiss":
      return { status: "idle" };
    default:
      return state;
  }
}

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
//
// presentation: "modal" gives NotesEditor its fixed-height container (see
// below) — this was previously the surface that had to fall back to a plain
// `<textarea>` because host.ui.RichTextEditor's ToastProvider dependency
// isn't satisfied inside the host's PluginModalHost (a host-platform gap,
// not fixable from this repo). Now that both surfaces share one markdown
// editor, that gap no longer applies to either surface.
// ---------------------------------------------------------------------------
export function makeNoteModalContent(host, taskId) {
  return function NoteModalContent() {
    const { jsx: h } = host;
    return h(NotesEditor, {
      host,
      taskId,
      surfaceId: "note-modal",
      presentation: "modal",
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

// TOOLBAR_ACTIONS drives MarkdownToolbar: each entry pairs a short glyph
// label (this bundle ships no icon set — see bookGlyph's own comment on why
// SVGs are hand-inlined elsewhere; plain glyphs are simpler for eight small
// buttons) with the pure transform it applies to the textarea's current
// selection.
const TOOLBAR_ACTIONS = [
  { id: "bold", title: "Bold", glyph: "B", glyphStyle: { fontWeight: 700 }, apply: applyBold },
  { id: "italic", title: "Italic", glyph: "I", glyphStyle: { fontStyle: "italic" }, apply: applyItalic },
  { id: "heading", title: "Heading", glyph: "H", apply: (text, selStart, selEnd) => applyHeading(text, selStart, selEnd, 2) },
  { id: "bullet-list", title: "Bullet list", glyph: "\u2022\u2261", apply: applyBulletList },
  { id: "numbered-list", title: "Numbered list", glyph: "1.\u2261", apply: applyNumberedList },
  { id: "link", title: "Link", glyph: "\uD83D\uDD17", apply: applyLink },
  { id: "inline-code", title: "Inline code", glyph: "</>", apply: applyInlineCode },
  { id: "code-block", title: "Code block", glyph: "{ }", apply: applyCodeBlock },
];

// MarkdownToolbar — the formatting toolbar (AC: bold, italic, heading,
// bullet/numbered list, link, inline code, code block). Each button calls
// onAction(applyFn); NotesEditor's applyTransform runs applyFn against the
// textarea's current selection and applies the resulting value/selection.
function MarkdownToolbar({ host, onAction, disabled }) {
  const { jsx: h, ui } = host;
  return h(
    "div",
    { role: "toolbar", "aria-label": "Formatting", style: { display: "flex", gap: "0.25rem", flexWrap: "wrap" } },
    ...TOOLBAR_ACTIONS.map((action) =>
      h(
        ui.Button,
        {
          key: action.id,
          type: "button",
          variant: "ghost",
          size: "icon",
          className: "h-7 w-7",
          title: action.title,
          "aria-label": action.title,
          "data-testid": `notes-toolbar-${action.id}`,
          disabled,
          onClick: () => onAction(action.apply),
        },
        h("span", { style: action.glyphStyle }, action.glyph),
      ),
    ),
  );
}

function NotesEditor({ host, taskId, surfaceId, presentation }) {
  const { jsx: h, ui } = host;
  const React = host.React;
  const { snapshot, store } = useNoteStore(host, { taskId, surfaceId });
  const textareaRef = React.useRef(null);
  const pendingSelectionRef = React.useRef(null);
  const [enhanceState, dispatchEnhance] = React.useReducer(enhancePreviewReducer, initialEnhanceState);

  const isMobile = presentation === "mobile";
  const isModal = presentation === "modal";
  const containerStyle = isModal
    ? // Fixed height (not a min-height) so the modal itself stops growing as
      // content is typed — the editor below scrolls internally instead
      // (AC: "fixed modal size with scrollable textarea").
      { display: "flex", flexDirection: "column", height: "70vh", maxHeight: "70vh", padding: "0.75rem", overflow: "hidden" }
    : isMobile
      ? { display: "flex", flexDirection: "column", height: "100%", padding: "0.5rem" }
      : { display: "flex", flexDirection: "column", height: "100%", padding: "0.75rem" };

  // Applies a pending caret/selection (set by applyTransform below) once the
  // textarea has re-rendered with the transformed value — a plain DOM
  // textarea does not track React-driven value changes' selection on its
  // own, so this restores it explicitly after each store-driven update.
  React.useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pending.start, pending.end);
      pendingSelectionRef.current = null;
    }
  });

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

  function applyTransform(transformFn) {
    const el = textareaRef.current;
    const selStart = el ? el.selectionStart : snapshot.value.length;
    const selEnd = el ? el.selectionEnd : snapshot.value.length;
    const result = transformFn(snapshot.value, selStart, selEnd);
    store.setValue(result.value);
    pendingSelectionRef.current = { start: result.selStart, end: result.selEnd };
  }

  function handleEnhanceClick() {
    if (enhanceState.status === "loading" || !snapshot.value) return;
    dispatchEnhance({ type: "start" });
    enhanceNote(host, snapshot.value).then(
      (content) => dispatchEnhance({ type: "success", content }),
      (error) =>
        dispatchEnhance({
          type: "failure",
          message: error && error.message ? error.message : "Could not enhance this note.",
          notConfigured: Boolean(error && error.notConfigured),
        }),
    );
  }

  function handleAcceptEnhance() {
    store.setValue(enhanceState.preview);
    dispatchEnhance({ type: "accept" });
  }

  function handleDiscardEnhance() {
    dispatchEnhance({ type: "discard" });
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

  const isEnhancing = enhanceState.status === "loading";
  const enhanceButton = h(
    ui.Button,
    {
      type: "button",
      variant: "ghost",
      size: "sm",
      onClick: handleEnhanceClick,
      disabled: isEnhancing || !snapshot.value,
      "aria-busy": isEnhancing,
      "data-testid": "notes-enhance-button",
      title: "Enhance with AI — proofread this note with your configured utility agent",
    },
    isEnhancing
      ? h(ui.Spinner, { className: "h-4 w-4" })
      : h("span", null, "\u2728 Enhance with AI"),
  );

  const enhancePreview =
    enhanceState.status === "preview"
      ? h(
          "div",
          {
            role: "region",
            "aria-label": "AI-enhanced preview",
            style: {
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: "0.375rem",
              padding: "0.5rem",
              marginTop: "0.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              maxHeight: "45%",
              overflowY: "auto",
            },
          },
          h("p", { style: { fontSize: "0.8rem", fontWeight: 600 } }, "AI-enhanced preview"),
          h(ui.Textarea, {
            value: enhanceState.preview,
            readOnly: true,
            className: "text-sm leading-relaxed font-mono",
            style: { minHeight: "6rem", overflowY: "auto" },
            "data-testid": "notes-enhance-preview",
          }),
          h(
            "div",
            { style: { display: "flex", gap: "0.5rem" } },
            h(
              ui.Button,
              { type: "button", size: "sm", onClick: handleAcceptEnhance, "data-testid": "notes-enhance-accept" },
              "Accept",
            ),
            h(
              ui.Button,
              {
                type: "button",
                size: "sm",
                variant: "ghost",
                onClick: handleDiscardEnhance,
                "data-testid": "notes-enhance-discard",
              },
              "Discard",
            ),
          ),
        )
      : null;

  const enhanceError =
    enhanceState.status === "error"
      ? h(
          "div",
          {
            role: "status",
            style: { fontSize: "0.8rem", color: "var(--destructive, #b91c1c)", marginTop: "0.25rem" },
            "data-testid": "notes-enhance-error",
          },
          enhanceState.message,
          h(
            ui.Button,
            { type: "button", size: "sm", variant: "ghost", onClick: () => dispatchEnhance({ type: "dismiss" }) },
            "Dismiss",
          ),
        )
      : null;

  return h(
    "div",
    { style: containerStyle },
    h(
      "p",
      { style: { color: "var(--muted-foreground)", fontSize: "0.8rem", marginBottom: "0.5rem" } },
      "Private to you — only you can see this note. Using \u201cEnhance with AI\u201d sends its content to your configured utility agent.",
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
        },
      },
      h(MarkdownToolbar, { host, onAction: applyTransform, disabled: isEnhancing }),
      enhanceButton,
    ),
    h(ui.Textarea, {
      ref: textareaRef,
      value: snapshot.value,
      onChange: (e) => store.setValue(e.target.value),
      placeholder: "Jot a note about this task… (Markdown supported)",
      className: "flex-1 min-h-0 resize-none text-sm leading-relaxed font-mono",
      style: { overflowY: "auto" },
      "data-testid": isModal ? "notes-modal-editor" : "notes-panel-editor",
    }),
    enhancePreview,
    enhanceError,
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
      "button",
      {
        type: "button",
        "data-testid": "notes-card-indicator",
        title: "Edit notes",
        "aria-label": "Edit notes",
        style: {
          display: "inline-flex",
          alignItems: "center",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        },
        onClick: (event) => {
          // Stop this from also triggering the card's own click-through to
          // open the task — the glyph is a shortcut to the note, not to the
          // task page.
          event.stopPropagation();
          event.preventDefault();
          openNoteModal(host, taskId);
        },
      },
      bookGlyph(host.jsx),
    );
  };
}

export function openNoteModal(host, taskId, taskTitle) {
  host.openModal({
    title: taskTitle ? `Edit notes — ${taskTitle}` : "Edit notes",
    content: makeNoteModalContent(host, taskId),
    // "xl" (sm:max-w-5xl) is the widest size PluginModalOptions offers —
    // closest match to a spacious note-editing surface. Height is fixed by
    // NotesEditor's own containerStyle for presentation "modal" (a fixed
    // height, not the modal's own dialog chrome), so the modal itself never
    // grows as the note is typed; the textarea scrolls internally instead.
    size: "xl",
  });
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
        openNoteModal(host, context.taskId, context.taskTitle);
      },
    });
  },

  destroy() {
    disposeNoteIndicatorSubscription();
    activeStores.forEach((store) => store.dispose());
    activeStores.clear();
  },
});
