// kandev-plugin-notes UI bundle — the frontend half of this plugin.
//
// This is a hand-written, NO-BUILD plain-JS ES module. It ships byte-for-byte
// inside the package tar.gz under ui/bundle.js, and kandev serves it directly
// from the extracted package, then dynamically imports it as a native ES
// module. There is nothing to build: edit this file and repackage
// (`make package` / `make package-host`).
//
// The plugin: a per-user, private scratchpad note on a task, edited as
// markdown on two surfaces:
//   - A task panel (registerTaskPanel, mobileEnabled) — renders
//     host.ui.RichTextEditor, the same TipTap-based WYSIWYG editor the Plan
//     panel uses (markdown-in/markdown-out via tiptap-markdown, bold/
//     italic/headings/lists/links/code blocks/checklists all reachable
//     through its own bubble menu and "/" slash commands — no custom
//     toolbar needed, mirroring how the Plan panel itself has none), and
//   - a kanban card menu action (registerTaskMenuAction, group "edit") that
//     opens a modal, bound to that card's own taskId. The modal keeps a
//     scrollable markdown `<textarea>` with its own formatting toolbar
//     (bold/italic/heading/lists/link/code/checklist) instead, because
//     host.ui.RichTextEditor cannot mount inside the host's PluginModalHost
//     (see makeNoteModalContent's comment for the ToastProvider gap this
//     hits — host-platform code this repo cannot change).
//   Both surfaces autosave through host.storage on the same debounced,
//   conflict-aware store.
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
// the operator-configured agent profile (README's Privacy section explains
// this trade-off).

// DEFAULT_SCOPE is the store/cache default when no scope is given, keeping
// every pre-existing task-scoped caller (panel, mobile panel, kanban modal,
// card indicator) working unchanged. A workspace note passes scope:
// "workspace" explicitly instead.
const DEFAULT_SCOPE = "task";
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

// applyCheckboxList toggles a GFM task-list marker ("- [ ] ") on every
// non-blank line the selection touches, mirroring applyBulletList's
// "converges to all-listified in one click" idiom: toggling off requires
// every non-blank line to already carry the checkbox marker, otherwise the
// action adds it to whichever lines are missing it. A line that already has
// a plain bullet ("- ") gets the checkbox inserted right after the dash
// rather than double-prefixed, so "- item" becomes "- [ ] item".
export function applyCheckboxList(text, selStart, selEnd) {
  const { start, end } = lineRangeBounds(text, selStart, selEnd);
  const block = text.slice(start, end);
  if (selStart === selEnd && block.trim() === "") {
    const marker = "- [ ] ";
    const value = text.slice(0, start) + marker + block + text.slice(end);
    return { value, selStart: selStart + marker.length, selEnd: selEnd + marker.length };
  }
  const lines = block.split("\n");
  const checkboxRe = /^-\s+\[[ xX]\]\s+/;
  const bulletOnlyRe = /^-\s+/;
  const allChecked = lines.every((l) => checkboxRe.test(l) || l.trim() === "");
  const newLines = lines.map((l) => {
    if (l.trim() === "") return l;
    if (allChecked) return l.replace(checkboxRe, "");
    if (checkboxRe.test(l)) return l;
    if (bulletOnlyRe.test(l)) return l.replace(bulletOnlyRe, (m) => `${m}[ ] `);
    return `- [ ] ${l}`;
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
    // 412 is this webhook's distinguishable agent-profile configuration
    // signal (server/plugin.go, mapped from gRPC FailedPrecondition per
    // ADR 0048) — surfaced as a clear, non-fatal message rather than a
    // generic failure. `code`/`detail` (C1) let the UI point at the right
    // settings page instead of one message covering unset/missing/ineligible
    // alike; an older server that omits them (C5) leaves both undefined and
    // the caller falls back to the plain message with no action button.
    const notConfigured = response.status === 412;
    const message = notConfigured
      ? (data && data.error) || "No agent profile is configured for this plugin yet."
      : (data && data.error) || `Could not enhance this note (status ${response.status}).`;
    const error = new Error(message);
    error.notConfigured = notConfigured;
    error.status = response.status;
    error.code = data && typeof data.code === "string" ? data.code : undefined;
    error.detail = data && typeof data.detail === "string" ? data.detail : undefined;
    throw error;
  }

  if (!data || typeof data.content !== "string") {
    const error = new Error("The AI enhance service returned an unexpected response.");
    error.notConfigured = false;
    throw error;
  }
  if (data.content.trim() === "") {
    const error = new Error("The AI enhance service returned an empty result.");
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
      return {
        status: "error",
        message: action.message,
        notConfigured: Boolean(action.notConfigured),
        code: action.code,
      };
    case "discard":
    case "accept":
    case "dismiss":
      return { status: "idle" };
    default:
      return state;
  }
}

// enhanceErrorAction (C2/C4) maps an enhance failure's `code` to the guided
// setup action NotesEditor's error branch renders beside Dismiss: which
// settings page fixes *this* cause, in its own words. "unset"/"missing" and
// "ineligible" all land on the Notes plugin page (pick an eligible profile);
// the legacy "disabled" and
// "unconfigured_profile" land on Utility Agents instead — a different page,
// because picking a profile there again would not fix either one (see
// server/plugin.go's classifyAgentProfileError comment for the host-side half
// of this split). The two Utility Agents causes keep separate labels because
// they are separate controls on that page: flipping Enabled, versus binding a
// model/profile. Telling someone to "enable" an agent they just enabled is
// the dead end this whole mapping exists to remove.
// A pure function (no host, no React) so C7's code -> action mapping is
// testable directly; returns null for an absent or unrecognized code, such as
// an older server that omits `code`.
export function enhanceErrorAction(code) {
  switch (code) {
    case "agent_unset":
    case "agent_missing":
      return { label: "Choose an agent profile", href: "/settings/plugins/kandev-plugin-notes" };
    case "agent_ineligible":
      return { label: "Choose an eligible profile", href: "/settings/plugins/kandev-plugin-notes" };
    case "agent_disabled":
      return { label: "Enable the agent", href: "/settings/utility-agents" };
    case "agent_unconfigured_profile":
      return { label: "Finish setting up the agent", href: "/settings/utility-agents" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// describeReadError — classifies a rejected host.storage.get() into a
// snapshot-safe shape ({ status, message, retryable, detail }) so the read
// path can surface *something* diagnosable instead of one fixed "Could not
// load this note." for every failure mode. host.storage.get (see
// apps/web/lib/plugins/host-api.ts) throws a plain Error whose message ends
// "status <code>" for a non-2xx/non-404 response, or a TypeError (e.g.
// "Failed to fetch") when the request itself never reached the server —
// there is no structured error.status to read directly, hence the regex.
// This mirrors enhanceNote's status-driven classification above (its 412
// case is the precedent), but for the read path there is no Response object
// to inspect — only the message text — which is exactly what the one-shot
// probe in createNoteStore exists to make up for.
// ---------------------------------------------------------------------------
const READ_ERROR_COPY = {
  401: {
    message: "Your session could not be verified. Try reloading the page.",
    retryable: false,
  },
  403: {
    message:
      "This plugin's storage access is disabled on this kandev instance. Ask an administrator to check its capability settings.",
    retryable: false,
  },
  400: {
    message: "This note's request was rejected by the server as invalid.",
    retryable: false,
  },
};

export function describeReadError(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  const statusMatch = message.match(/status (\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status !== undefined) {
    const copy = READ_ERROR_COPY[status];
    if (copy) return { status, message: copy.message, retryable: copy.retryable, detail: message };
    if (status >= 500) {
      return {
        status,
        message: "The server had a problem loading this note.",
        retryable: true,
        detail: message,
      };
    }
    return { status, message: "Could not load this note.", retryable: false, detail: message };
  }

  if (error instanceof TypeError) {
    return {
      status: undefined,
      message: "Could not reach the server. Check your connection and try again.",
      retryable: true,
      detail: message,
    };
  }

  return { status: undefined, message: "Could not load this note.", retryable: false, detail: message };
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
//   - setScopeId() (alias: setTaskId()) clears value/updatedAt synchronously
//     (before the new scopeId's read resolves) so a write in flight for the
//     old scopeId can never be sent under the new one's id with a stale
//     ifUnmodifiedSince.
//
// scope defaults to "task" (and scopeId falls back to the legacy `taskId`
// option) so every pre-existing caller is unaffected; a workspace note store
// passes { scope: "workspace", scopeId: workspaceId } instead. scope itself
// is fixed for a store's lifetime — only scopeId changes via setScopeId.
// ---------------------------------------------------------------------------
export function createNoteStore(host, { scope = DEFAULT_SCOPE, scopeId, taskId, surfaceId, onCommit }) {
  const currentScope = scope;
  let currentScopeId = scopeId ?? taskId;
  let value = "";
  let updatedAt;
  let loadedScopeId = null;
  let readError = null;
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

  // Auto-retry (AC6): a `retryable` classification (describeReadError) gets
  // up to AUTO_RETRY_LIMIT automatic attempts with exponential backoff
  // before resting on the user's manual Retry button. Non-retryable
  // failures (401/403, or anything the probe can't improve on) never
  // schedule one. Reused/cleared on every successful refresh and on
  // setTaskId — a new task, or a working read, gets a fresh budget.
  const AUTO_RETRY_LIMIT = 3;
  const AUTO_RETRY_BASE_MS = 1000;
  let autoRetryCount = 0;
  let autoRetryTimer;

  function clearAutoRetryTimer() {
    if (autoRetryTimer !== undefined) {
      clearTimeout(autoRetryTimer);
      autoRetryTimer = undefined;
    }
  }

  function scheduleAutoRetry(forScopeId) {
    if (!readError || !readError.retryable) return;
    if (autoRetryCount >= AUTO_RETRY_LIMIT) return;
    autoRetryCount += 1;
    const delay = AUTO_RETRY_BASE_MS * 2 ** (autoRetryCount - 1);
    autoRetryTimer = setTimeout(() => {
      autoRetryTimer = undefined;
      if (disposed || forScopeId !== currentScopeId) return;
      refresh();
    }, delay);
  }

  // issueReadErrorProbe (AC3): the rejection that drives describeReadError
  // carries only a message string (host.storage.get throws a plain Error,
  // see describeReadError's own comment) — this probe re-issues the same
  // logical read as a raw host.api.fetch so the snapshot can carry the real
  // response.status and any JSON error body instead of a regex guess. Fires
  // at most once per rejected refresh(); a probe for a superseded
  // generation/scopeId is dropped by the same guard refresh() itself uses,
  // and a probe that itself fails just leaves the describeReadError
  // classification in place.
  function issueReadErrorProbe(rawError, generation, forScopeId) {
    const fetchApi = host.api && host.api.fetch;
    const probe =
      typeof fetchApi === "function"
        ? Promise.resolve(fetchApi(`user-state/${currentScope}/${forScopeId}/${NOTE_KEY}`)).then(
            async (response) => {
              let body = null;
              try {
                body = await response.json();
              } catch {
                body = null;
              }
              const backendMessage = body && typeof body.error === "string" ? body.error : undefined;
              return {
                status: response.status,
                detail: backendMessage ? `status ${response.status}: ${backendMessage}` : `status ${response.status}`,
              };
            },
            () => undefined,
          )
        : Promise.resolve(undefined);

    probe.then((probeInfo) => {
      if (!disposed && generation === refreshGeneration && forScopeId === currentScopeId && probeInfo) {
        readError = { ...readError, status: probeInfo.status, detail: probeInfo.detail };
        notify();
      }
      // eslint-disable-next-line no-console
      console.warn(
        "[kandev-plugin-notes] failed to load note",
        rawError,
        probeInfo ? probeInfo.status : undefined,
      );
    });
  }

  const listeners = new Set();
  function notify() {
    listeners.forEach((listener) => listener());
  }

  function getSnapshot() {
    return {
      scope: currentScope,
      scopeId: currentScopeId,
      taskId: currentScope === "task" ? currentScopeId : null,
      value,
      loaded: loadedScopeId === currentScopeId,
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
    const forScopeId = currentScopeId;
    return host.storage.get(currentScope, forScopeId, NOTE_KEY).then(
      (entry) => {
        if (disposed || generation !== refreshGeneration || forScopeId !== currentScopeId) return false;
        if (!preserveValue && !dirty) value = entry ? entry.value : "";
        updatedAt = entry ? entry.updatedAt : undefined;
        loadedScopeId = forScopeId;
        readError = null;
        autoRetryCount = 0;
        clearAutoRetryTimer();
        notify();
        return true;
      },
      (rawError) => {
        // Do not mark this scopeId loaded after a rejected read: an empty
        // editor here could omit ifUnmodifiedSince on its first save and
        // silently overwrite an existing note. Stay in a retry state.
        if (disposed || generation !== refreshGeneration || forScopeId !== currentScopeId) return false;
        readError = describeReadError(rawError);
        notify();
        scheduleAutoRetry(forScopeId);
        issueReadErrorProbe(rawError, generation, forScopeId);
        return false;
      },
    );
  }

  function subscribeStorage() {
    if (unsubscribeStorage) unsubscribeStorage();
    const forScopeId = currentScopeId;
    unsubscribeStorage = host.storage.subscribe(
      { scope: currentScope, scopeId: forScopeId, key: NOTE_KEY, writerId: surfaceId },
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

  function setScopeId(nextScopeId) {
    if (nextScopeId === currentScopeId) return;
    currentScopeId = nextScopeId;
    value = "";
    updatedAt = undefined;
    loadedScopeId = null;
    readError = null;
    autoRetryCount = 0;
    clearAutoRetryTimer();
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
    // AC4: a rejected read must never permit a write — an empty/stale
    // editor value saved under readError could silently overwrite an
    // existing note (see refresh()'s reject handler above).
    if (writeBlocked || writeInFlight || pendingValue === undefined || readError) return;
    const generation = writeGeneration;
    const forScopeId = currentScopeId;
    const next = pendingValue;
    pendingValue = undefined;
    writeInFlight = true;
    host.storage
      .set(currentScope, forScopeId, NOTE_KEY, next, { writerId: surfaceId, ifUnmodifiedSince: updatedAt })
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
    clearAutoRetryTimer();
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
    setScopeId,
    // setTaskId: alias for setScopeId, kept for the "task" scope's existing
    // callers (useNoteStore's own effect, and any external caller written
    // before scope existed) — same synchronous clear-before-read guarantee.
    setTaskId: setScopeId,
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
// (scope, scopeId) per page session. A second render serves the cache; a
// cross-tab subscribe notification updates it from the notification's
// `deleted` flag alone (no refetch — the payload carries no value); and a
// successful local write updates it directly, since own-tab echoes of that
// write are suppressed by the writerId-scoped subscription above and would
// never reach this module-level listener otherwise.
//
// Keyed by `${scope}:${scopeId}` (cacheKey below) so a task and a workspace
// that happen to share a raw id never collide — every exported helper below
// takes a `scope` argument defaulting to "task", the pre-existing (and only,
// before workspace notes) caller.
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

function cacheKey(scope, scopeId) {
  return `${scope}:${scopeId}`;
}

function notifyCacheListeners(key) {
  const listeners = cacheListeners.get(key);
  if (!listeners) return;
  const hasNote = noteCache.get(key) ?? false;
  listeners.forEach((listener) => listener(hasNote));
}

export function markNote(scopeId, hasNote, scope = DEFAULT_SCOPE) {
  const key = cacheKey(scope, scopeId);
  noteCache.set(key, hasNote);
  notifyCacheListeners(key);
}

export function getCachedHasNote(host, scopeId, scope = DEFAULT_SCOPE) {
  const key = cacheKey(scope, scopeId);
  if (noteCache.has(key)) return Promise.resolve(noteCache.get(key));
  const pending = pendingGets.get(key);
  if (pending) return pending;

  const request = host.storage.get(scope, scopeId, NOTE_KEY).then(
    (entry) => {
      pendingGets.delete(key);
      const hasNote = Boolean(entry && typeof entry.value === "string" && entry.value !== "");
      noteCache.set(key, hasNote);
      notifyCacheListeners(key);
      return hasNote;
    },
    () => {
      // Leave this key uncached on a failed read so a later render can
      // retry, instead of pinning it to a possibly-wrong false forever.
      pendingGets.delete(key);
      return false;
    },
  );
  pendingGets.set(key, request);
  return request;
}

export function subscribeCache(scopeId, listener, scope = DEFAULT_SCOPE) {
  const key = cacheKey(scope, scopeId);
  let listeners = cacheListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    cacheListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) cacheListeners.delete(key);
  };
}

// initNoteIndicatorSubscription is called from initialize() every time the
// plugin is (re-)enabled. It tears down any prior subscription first so
// calling initialize() twice in one tab (disable -> re-enable) still leaves
// exactly one module-level subscription, never two. No `scope` filter here
// (deliberately, unlike a single store's own subscribeStorage): one
// subscription must see every scope's note changes, task and workspace
// alike, so a workspace note write also flips its sidebar-button cache entry.
export function initNoteIndicatorSubscription(host) {
  if (indicatorUnsubscribe) indicatorUnsubscribe();
  indicatorUnsubscribe = host.storage.subscribe({ key: NOTE_KEY }, (change) => {
    markNote(change.scopeId, !change.deleted, change.scope);
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
// below) AND keeps it on the markdown-textarea-plus-toolbar editor rather
// than host.ui.RichTextEditor (the real, Plan-panel-identical TipTap editor
// NotesEditor uses for the "panel"/"mobile" surfaces below): RichTextEditor
// internally calls useMermaidErrorToast, which requires a ToastProvider
// ancestor, and the host's PluginModalHost (where this modal mounts) does
// not render one — confirmed live (empty, uneditable modal body). That is
// host-platform code this repo cannot change, so the modal keeps the
// textarea+toolbar fallback until the host wraps plugin modals in one.
//
// { scope, scopeId } generalizes this factory beyond the task modal — the
// workspace sidebar button (openWorkspaceNoteModal) reuses it unchanged with
// scope: "workspace". `close`, when given, is the owning PluginModalHandle's
// close() (see openScopedNoteModal below) — NotesEditor's enhance-error
// action (C4) closes the modal before navigating away from it.
// ---------------------------------------------------------------------------
export function makeNoteModalContent(host, { scope = DEFAULT_SCOPE, scopeId, taskId } = {}, close) {
  const resolvedScopeId = scopeId ?? taskId;
  return function NoteModalContent() {
    const { jsx: h } = host;
    return h(NotesEditor, {
      host,
      scope,
      scopeId: resolvedScopeId,
      taskId: scope === DEFAULT_SCOPE ? resolvedScopeId : undefined,
      surfaceId: "note-modal",
      presentation: "modal",
      onCloseModal: close,
    });
  };
}

// ---------------------------------------------------------------------------
// React layer. Deliberately thin: all the guard logic above is framework-
// free and unit-tested directly; these components only subscribe to it.
// ---------------------------------------------------------------------------
function useNoteStore(host, { scope = DEFAULT_SCOPE, scopeId, taskId, surfaceId }) {
  const React = host.React;
  const resolvedScopeId = scopeId ?? taskId;
  const storeRef = React.useRef(null);
  const [snapshot, setSnapshot] = React.useState(null);

  React.useEffect(() => {
    const store = createNoteStore(host, {
      scope,
      scopeId: resolvedScopeId,
      surfaceId,
      onCommit: (hasNote) => {
        const snap = store.getSnapshot();
        markNote(snap.scopeId, hasNote, snap.scope);
      },
    });
    storeRef.current = store;
    setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    return () => {
      unsubscribe();
      store.dispose();
      storeRef.current = null;
    };
    // surfaceId/scope identify the store; a scopeId change while the same
    // surface stays mounted is handled by the effect below via
    // store.setScopeId(), not by recreating the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, surfaceId, scope]);

  React.useEffect(() => {
    if (storeRef.current) storeRef.current.setScopeId(resolvedScopeId);
  }, [resolvedScopeId]);

  return { snapshot, store: storeRef.current };
}

// TOOLBAR_ACTIONS drives MarkdownToolbar: each entry pairs a short glyph
// label (this bundle ships no icon set — see bookGlyph's own comment on why
// SVGs are hand-inlined elsewhere; plain glyphs are simpler for nine small
// buttons) with the pure transform it applies to the textarea's current
// selection.
const TOOLBAR_ACTIONS = [
  { id: "bold", title: "Bold", glyph: "B", glyphStyle: { fontWeight: 700 }, apply: applyBold },
  { id: "italic", title: "Italic", glyph: "I", glyphStyle: { fontStyle: "italic" }, apply: applyItalic },
  { id: "heading", title: "Heading", glyph: "H", apply: (text, selStart, selEnd) => applyHeading(text, selStart, selEnd, 2) },
  { id: "bullet-list", title: "Bullet list", glyph: "\u2022\u2261", apply: applyBulletList },
  { id: "numbered-list", title: "Numbered list", glyph: "1.\u2261", apply: applyNumberedList },
  { id: "checkbox-list", title: "Checklist", glyph: "\u2611", apply: applyCheckboxList },
  { id: "link", title: "Link", glyph: "\uD83D\uDD17", apply: applyLink },
  { id: "inline-code", title: "Inline code", glyph: "</>", apply: applyInlineCode },
  { id: "code-block", title: "Code block", glyph: "{ }", apply: applyCodeBlock },
];

// MarkdownToolbar — the formatting toolbar (AC: bold, italic, heading,
// bullet/numbered/checkbox list, link, inline code, code block). Each button calls
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

const STYLE_ELEMENT_ID = "kandev-plugin-notes-styles";

// injectPluginStyles — a one-time <style> tag this plugin owns, scoped to
// its own DOM via the "kandev-notes-richtext" class NotesEditor puts on
// host.ui.RichTextEditor. It exists for exactly one rule: hiding the
// TipTap Plan editor's comment ("speech bubble") bubble-menu button, which
// host.ui.RichTextEditor inherits unconditionally.
//
// TipTapPlanEditor (the component RichTextEditor wraps) always renders
// <PlanBubbleMenu onComment={handleBubbleComment} />, where
// handleBubbleComment just forwards to props.onSelectionChange — it never
// checks whether that prop is actually set. RichTextEditor's plugin-facing
// contract (rich-text-editor.tsx) deliberately forwards only
// {value, onChange, placeholder, className, testId}, NOT
// onSelectionChange/onCommentClick/comments/onCommentDeleted, so plugins
// have no way to wire the comment button up to anything — clicking it is a
// silent no-op (Report: comment icon does nothing in the notes panel).
// There is also no per-editor prop to ask TipTapPlanEditor to omit that
// button. Both are host-platform code this repo cannot change; the button
// itself is only reachable to hide via a CSS selector unique enough not to
// hit anything else. `.bg-primary.text-primary-foreground` is exactly that:
// grep confirms only ToggleButton's `accent` variant (used solely by the
// comment button, see plan-bubble-menu.tsx) pairs those two classes inside
// a Plan/RichTextEditor subtree.
export function injectPluginStyles() {
  // Node's `node --test` harness (ui/bundle.test.mjs) has no DOM — guard so
  // initialize() stays callable there without a `document` global.
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent =
    ".kandev-notes-richtext .bg-primary.text-primary-foreground { display: none !important; }";
  document.head.appendChild(style);
}

// notePlaceholderFor names the thing the note is actually about. NotesEditor
// renders for both scopes now, so a single hardcoded "about this task" reads
// as wrong copy directly under a modal titled "Workspace notes — <label>".
// Pure and exported so the wording is unit-testable without a DOM, like
// enhanceErrorAction.
export function notePlaceholderFor(scope) {
  const subject = scope === "workspace" ? "workspace" : "task";
  return `Jot a note about this ${subject}… (Markdown supported)`;
}

function NotesEditor({ host, scope = DEFAULT_SCOPE, scopeId, taskId, surfaceId, presentation, onCloseModal }) {
  const { jsx: h, ui } = host;
  const React = host.React;
  const resolvedScopeId = scopeId ?? taskId;
  const notePlaceholder = notePlaceholderFor(scope);
  const { snapshot, store } = useNoteStore(host, { scope, scopeId: resolvedScopeId, surfaceId });
  const textareaRef = React.useRef(null);
  const pendingSelectionRef = React.useRef(null);
  const [enhanceState, dispatchEnhance] = React.useReducer(enhancePreviewReducer, initialEnhanceState);

  const isMobile = presentation === "mobile";
  const isModal = presentation === "modal";
  // The panel/mobile surfaces use host.ui.RichTextEditor — the same TipTap
  // editor the Plan panel renders (bold/italic/headings/lists/links/code
  // blocks/checklists all built in via its own bubble menu + "/" slash
  // commands, no custom toolbar needed). The kanban modal surface cannot:
  // see makeNoteModalContent's comment for why (ToastProvider gap in
  // PluginModalHost) — it keeps the markdown textarea + MarkdownToolbar.
  const useRichEditor = !isModal;
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

  // RichTextEditor (see rich-text-editor.tsx) only consumes its `value` prop
  // as the TipTap editor's *initial* content — like the Plan panel, there is
  // no effect syncing later `value` changes into an already-mounted editor.
  // The Plan panel's own fix for this is to bump a `key` (see
  // task-plan-panel.tsx's `editorKey`) to force a remount whenever the
  // content changes for a reason other than the editor's own onChange (a
  // cross-tab sync refresh, or an accepted "Enhance with AI" preview) — this
  // mirrors that pattern. lastRichValueRef tracks the value this editor
  // instance already has, so the effect below can tell "my own onChange
  // echoed back" (no remount, would cost the caret position) apart from "the
  // value moved out from under me" (remount needed).
  const [editorKey, setEditorKey] = React.useState(0);
  const lastRichValueRef = React.useRef(null);
  React.useEffect(() => {
    if (!useRichEditor || !snapshot || !snapshot.loaded) return;
    if (lastRichValueRef.current === null) {
      lastRichValueRef.current = snapshot.value;
      return;
    }
    if (snapshot.value !== lastRichValueRef.current) {
      lastRichValueRef.current = snapshot.value;
      setEditorKey((k) => k + 1);
    }
  }, [useRichEditor, snapshot && snapshot.loaded, snapshot && snapshot.value]);

  // The modal's markdown textarea has no live rendering of its own (unlike
  // the panel's RichTextEditor, which renders WYSIWYG as you type) — a
  // "Preview" toggle lets the user see checkboxes/headings/lists/links/code
  // blocks rendered the same way the panel shows them, via
  // host.ui.RichTextReadOnly (PlanReadOnlyMarkdown under the hood). That
  // component is safe to mount inside the modal where the fully-editable
  // RichTextEditor is not (see makeNoteModalContent's comment): it is
  // `editable: false` and never calls useMermaidErrorToast, so it has no
  // ToastProvider dependency. It only *renders* markdown, though — TipTap's
  // TaskItem checkbox stays inert while editable: false, so toggling a
  // checkbox still has to happen in the textarea (typing "x" inside
  // `[ ]`) or via the Checklist toolbar button, not by clicking the
  // rendered preview.
  const [showPreview, setShowPreview] = React.useState(false);

  function handleRichTextChange(next) {
    lastRichValueRef.current = next;
    store.setValue(next);
  }

  if (!snapshot) {
    return h("div", { style: containerStyle }, "Loading notes…");
  }
  if (snapshot.readError) {
    const { message, detail } = snapshot.readError;
    return h(
      "div",
      { style: containerStyle },
      h("p", null, message || "Could not load this note."),
      detail
        ? h(
            "p",
            { style: { fontSize: "0.75rem", color: "var(--muted-foreground)" } },
            detail,
          )
        : null,
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
          code: error && error.code,
        }),
    );
  }

  // handleEnhanceErrorAction (C4): navigates to the settings page
  // enhanceErrorAction resolved for the current error's code. Closes this
  // surface's own modal first when there is one (onCloseModal, threaded
  // down from makeNoteModalContent/openScopedNoteModal) — navigating away
  // while the modal is still open would leave it mounted over the
  // destination page.
  function handleEnhanceErrorAction(action) {
    if (onCloseModal) onCloseModal();
    host.navigate(action.href);
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
      title: "Enhance with AI — proofread this note with your configured agent profile",
    },
    isEnhancing
      ? h(ui.Spinner, { className: "h-4 w-4" })
      : h("span", null, "\u2728 Enhance with AI"),
  );

  const previewToggleButton = isModal
    ? h(
        ui.Button,
        {
          type: "button",
          variant: showPreview ? "secondary" : "ghost",
          size: "sm",
          onClick: () => setShowPreview((v) => !v),
          "data-testid": "notes-preview-toggle",
          title: showPreview
            ? "Back to editing"
            : "Preview — see checkboxes, headings, lists, links, and code blocks rendered",
        },
        showPreview ? "Edit" : "Preview",
      )
    : null;

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

  const enhanceErrorGuidedAction = enhanceState.status === "error" ? enhanceErrorAction(enhanceState.code) : null;
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
          enhanceErrorGuidedAction
            ? h(
                ui.Button,
                {
                  type: "button",
                  size: "sm",
                  variant: "ghost",
                  "data-testid": "notes-enhance-error-action",
                  onClick: () => handleEnhanceErrorAction(enhanceErrorGuidedAction),
                },
                enhanceErrorGuidedAction.label,
              )
            : null,
        )
      : null;

  return h(
    "div",
    { style: containerStyle },
    h(
      "p",
      { style: { color: "var(--muted-foreground)", fontSize: "0.8rem", marginBottom: "0.5rem" } },
      "Private to you — only you can see this note. Using \u201cEnhance with AI\u201d sends its content to your configured agent profile.",
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
        },
      },
      // The rich editor (panel/mobile) needs no custom toolbar — bold,
      // italic, headings, lists, links, code blocks and checklists are all
      // reachable through its own bubble menu (on selection) and "/" slash
      // commands, exactly like the Plan panel. Only the modal's plain
      // textarea needs MarkdownToolbar's buttons, and only while not
      // previewing (the preview has nothing to apply a selection-based
      // transform to).
      useRichEditor || showPreview
        ? null
        : h(MarkdownToolbar, { host, onAction: applyTransform, disabled: isEnhancing }),
      h(
        "div",
        { style: { display: "flex", gap: "0.25rem", marginLeft: "auto" } },
        previewToggleButton,
        enhanceButton,
      ),
    ),
    useRichEditor
      ? h(ui.RichTextEditor, {
          key: `${surfaceId}-${resolvedScopeId}-${editorKey}`,
          taskId: resolvedScopeId,
          value: snapshot.value,
          onChange: handleRichTextChange,
          placeholder: notePlaceholder,
          // kandev-notes-richtext: scopes the CSS rule (injected once by
          // injectPluginStyles, see below) that hides the dead "comment"
          // bubble-menu button host.ui.RichTextEditor inherits from the
          // Plan editor — see that function's own comment for why it can
          // never work here and can't be fixed by omitting a prop.
          className: "flex-1 min-h-0 kandev-notes-richtext",
          testId: "notes-panel-editor",
        })
      : showPreview
        ? h(ui.RichTextReadOnly, {
            value: snapshot.value,
            className: "flex-1 min-h-0 overflow-y-auto border rounded-md",
            testId: "notes-modal-preview",
          })
        : h(ui.Textarea, {
            ref: textareaRef,
            value: snapshot.value,
            onChange: (e) => store.setValue(e.target.value),
            placeholder: notePlaceholder,
            className: "flex-1 min-h-0 resize-none text-sm leading-relaxed font-mono",
            style: { overflowY: "auto" },
            "data-testid": "notes-modal-editor",
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

function bookGlyph(h, size = 12) {
  // Inline SVG — this bundle ships no build step and cannot import an icon
  // set. Matches the curated "book" icon used for the panel's own tab. size
  // defaults to the card indicator's 12px; the sidebar button passes 14 to
  // match its siblings' `h-3.5 w-3.5` (RowActionButton) glyph size.
  return h(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
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

function useNoteIndicator(host, scopeId, scope = DEFAULT_SCOPE) {
  const React = host.React;
  const [hasNote, setHasNote] = React.useState(() => noteCache.get(cacheKey(scope, scopeId)) ?? false);

  React.useEffect(() => {
    if (!scopeId) return undefined;
    let cancelled = false;
    getCachedHasNote(host, scopeId, scope).then((value) => {
      if (!cancelled) setHasNote(value);
    });
    const unsubscribe = subscribeCache(
      scopeId,
      (value) => {
        if (!cancelled) setHasNote(value);
      },
      scope,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host, scopeId, scope]);

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

// openScopedNoteModal is the shared body behind openNoteModal (scope:
// "task") and openWorkspaceNoteModal (scope: "workspace") — same modal
// chrome, same fixed-height NotesEditor, differing only in scope/scopeId and
// title. The PluginModalHandle host.openModal returns is only available
// *after* the call, but makeNoteModalContent needs a close() callback to
// hand NotesEditor *before* that — closeRef bridges the gap: the content
// factory closes over closeRef and calls whatever's in it, which is filled
// in immediately after openModal returns, before React ever renders the
// modal body.
function openScopedNoteModal(host, { scope, scopeId, title }) {
  const closeRef = {};
  const content = makeNoteModalContent(host, { scope, scopeId }, () => closeRef.close && closeRef.close());
  const handle = host.openModal({
    title,
    content,
    // "xl" (sm:max-w-5xl) is the widest size PluginModalOptions offers —
    // closest match to a spacious note-editing surface. Height is fixed by
    // NotesEditor's own containerStyle for presentation "modal" (a fixed
    // height, not the modal's own dialog chrome), so the modal itself never
    // grows as the note is typed; the textarea scrolls internally instead.
    size: "xl",
  });
  closeRef.close = handle.close;
  return handle;
}

export function openNoteModal(host, taskId, taskTitle) {
  return openScopedNoteModal(host, {
    scope: DEFAULT_SCOPE,
    scopeId: taskId,
    title: taskTitle ? `Edit notes — ${taskTitle}` : "Edit notes",
  });
}

// openWorkspaceNoteModal is the sidebar button's entry point (B3) — same
// NotesEditor, same PluginModalHost, scope: "workspace" instead of "task".
export function openWorkspaceNoteModal(host, workspaceId, workspaceLabel) {
  return openScopedNoteModal(host, {
    scope: "workspace",
    scopeId: workspaceId,
    title: workspaceLabel ? `Workspace notes — ${workspaceLabel}` : "Workspace notes",
  });
}

// resolveWorkspaceId prefers the sidebar slot's own slotProps.workspaceId
// (forwarded by the host from the same useAppStore read the New Task row
// itself performs — see app-sidebar-workspace-actions.tsx) and falls back to
// reading the app store directly, per B6, so the button still resolves an id
// on a host that predates that slotProps field.
function resolveWorkspaceId(slotProps, host) {
  if (slotProps && slotProps.workspaceId) return slotProps.workspaceId;
  const state = host.store && typeof host.store.getState === "function" ? host.store.getState() : null;
  return (state && state.workspaces && state.workspaces.activeId) || null;
}

// makeWorkspaceNotesButton — the sidebar-workspace-actions slot component
// (B3-B6). Pixel-identical to its RowActionButton siblings (Quick Terminal,
// Quick Chat): same 24px hit target, same hover classes, same 14px glyph
// size — text-muted-foreground/70 when the workspace has no note,
// text-foreground once it does (B5), flipping live via useNoteIndicator's
// cache subscription, including a write from another tab.
function makeWorkspaceNotesButton(host) {
  return function WorkspaceNotesButton({ slotProps }) {
    const workspaceId = resolveWorkspaceId(slotProps, host);
    const workspaceLabel = slotProps && slotProps.workspaceLabel;
    const hasNote = useNoteIndicator(host, workspaceId, "workspace");
    if (!workspaceId) return null;
    return host.jsx(
      "button",
      {
        type: "button",
        "data-testid": "notes-workspace-sidebar-button",
        title: "Workspace notes",
        "aria-label": "Workspace notes",
        className: `flex h-6 w-6 items-center justify-center rounded cursor-pointer hover:bg-muted hover:text-foreground ${
          hasNote ? "text-foreground" : "text-muted-foreground/70"
        }`,
        onClick: () => openWorkspaceNoteModal(host, workspaceId, workspaceLabel),
      },
      bookGlyph(host.jsx, 14),
    );
  };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------
window.registerKandevPlugin("kandev-plugin-notes", {
  initialize(registry, host) {
    initNoteIndicatorSubscription(host);
    injectPluginStyles();

    registry.registerTaskPanel({
      id: "notes",
      title: "Notes",
      icon: "book",
      Component: makeNotesPanelComponent(host),
      mobileEnabled: true,
    });

    registry.registerComponent("task-card-indicators", makeCardIndicatorComponent(host));

    // Workspace-scoped note button (B3-B7). Registering for a slot name the
    // host doesn't (yet) mount is a documented no-op (PluginRegistry does no
    // name validation; PluginSlot renders nothing for zero registrations),
    // so this stays inert on a host build without the sidebar slot.
    registry.registerComponent("sidebar-workspace-actions", makeWorkspaceNotesButton(host));

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
