// node --test suite for ui/bundle.js's framework-free logic (AC8-AC19 in the
// task plan). No React, no jsdom, no build step: the guard logic under test
// (createNoteStore, the card-indicator cache, and the kanban modal factory)
// is exported from bundle.js purely for this import; the plugin itself still
// registers via window.registerKandevPlugin at module-evaluation time (see
// the bottom of this file for that capture).
//
// React component markup (NotesEditor, the panel/card-indicator JSX bodies)
// is deliberately not covered here — see plan §6. Where a wrapper component
// (NotesPanel, NoteModalContent) does nothing but call host.jsx(...) once
// with no hooks of its own, this suite calls it directly as a plain function
// to inspect the props it passes, without invoking React.

import { test, mock } from "node:test";
import assert from "node:assert/strict";

class PluginStorageConflictError extends Error {
  constructor() {
    super("plugin storage: value was modified since ifUnmodifiedSince");
    this.name = "PluginStorageConflictError";
  }
}

// createFakeStorage returns a host.storage double whose get/set/delete calls
// resolve on demand (each call object exposes .resolve()/.reject()), so
// out-of-order resolution and debounce timing are deterministic rather than
// timing-dependent. subscribers/emit let tests drive host.storage.subscribe
// notifications directly.
function createFakeStorage() {
  const calls = [];
  const subscribers = [];

  function deferredCall(method, args) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call = { method, args, promise, resolve, reject };
    calls.push(call);
    return call;
  }

  const storage = {
    get(scope, scopeId, key) {
      return deferredCall("get", { scope, scopeId, key }).promise;
    },
    set(scope, scopeId, key, value, options) {
      return deferredCall("set", { scope, scopeId, key, value, options }).promise;
    },
    delete(scope, scopeId, key, options) {
      return deferredCall("delete", { scope, scopeId, key, options }).promise;
    },
    list() {
      return deferredCall("list", {}).promise;
    },
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subscribers.push(entry);
      return () => {
        const i = subscribers.indexOf(entry);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  };

  function emit(change) {
    subscribers.slice().forEach((s) => {
      const f = s.filter;
      if (f.scope && f.scope !== change.scope) return;
      if (f.scopeId && f.scopeId !== change.scopeId) return;
      if (f.key && f.key !== change.key) return;
      s.handler(change);
    });
  }

  function callsOf(method) {
    return calls.filter((c) => c.method === method);
  }

  return { storage, calls, subscribers, emit, callsOf };
}

// flush drains pending microtasks — enough hops for a `.then(a, b).finally(c)`
// chain (or a couple of them in sequence) to fully settle, so assertions
// after resolving/rejecting a fake host.storage call see its effects.
async function flush(hops = 6) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function createJsxSpy() {
  const calls = [];
  function jsx(type, props, ...children) {
    const call = { type, props: props || {}, children };
    calls.push(call);
    return call;
  }
  return { jsx, calls };
}

function createFakeRegistry() {
  const registerTaskPanel = [];
  const registerComponent = [];
  const registerTaskMenuAction = [];
  return {
    registerTaskPanel: (r) => registerTaskPanel.push(r),
    registerComponent: (slot, Component) => registerComponent.push({ slot, Component }),
    registerTaskMenuAction: (r) => registerTaskMenuAction.push(r),
    registerNavItem: () => {},
    registerRoute: () => {},
    registerWsHandler: () => {},
    registerKeybinding: () => {},
    registerSettingsRoute: () => {},
    registerTaskPanelCalls: registerTaskPanel,
    registerComponentCalls: registerComponent,
    registerTaskMenuActionCalls: registerTaskMenuAction,
  };
}

function createFakeHost() {
  const { storage, calls, subscribers, emit, callsOf } = createFakeStorage();
  const { jsx, calls: jsxCalls } = createJsxSpy();
  const openModalCalls = [];
  const host = {
    storage,
    jsx,
    React: null,
    openModal: (options) => {
      openModalCalls.push(options);
      return { close() {} };
    },
    ui: {},
  };
  return { host, storageCalls: calls, subscribers, emit, callsOf, jsxCalls, openModalCalls };
}

// ---------------------------------------------------------------------------
// Import bundle.js. It calls window.registerKandevPlugin(id, plugin) as a
// side effect of evaluation, so the capture must be wired up first.
// ---------------------------------------------------------------------------
let registeredPluginId;
let registeredPlugin;
globalThis.window = globalThis;
globalThis.registerKandevPlugin = (id, plugin) => {
  registeredPluginId = id;
  registeredPlugin = plugin;
};

const bundle = await import("../ui/bundle.js");
const {
  createNoteStore,
  markNote,
  getCachedHasNote,
  subscribeCache,
  initNoteIndicatorSubscription,
  disposeNoteIndicatorSubscription,
  makeNoteModalContent,
  openNoteModal,
  applyBold,
  applyItalic,
  applyHeading,
  applyBulletList,
  applyNumberedList,
  applyLink,
  applyInlineCode,
  applyCodeBlock,
  enhanceNote,
  enhancePreviewReducer,
  initialEnhanceState,
} = bundle;

test("registers under the manifest's plugin id", () => {
  assert.equal(registeredPluginId, "kandev-plugin-notes");
  assert.equal(typeof registeredPlugin.initialize, "function");
  assert.equal(typeof registeredPlugin.destroy, "function");
});

// --- AC8: initial load reflects stored value, or empty when unset --------

test("AC8: a stored note populates the store's value once loaded", async () => {
  const { host, callsOf } = createFakeHost();
  const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
  assert.equal(store.getSnapshot().loaded, false);

  callsOf("get")[0].resolve({ value: "existing note", updatedAt: "u1" });
  await flush();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.loaded, true);
  assert.equal(snapshot.value, "existing note");
  store.dispose();
});

test("AC8: no stored entry resolves to an empty value", async () => {
  const { host, callsOf } = createFakeHost();
  const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });

  callsOf("get")[0].resolve(undefined);
  await flush();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.loaded, true);
  assert.equal(snapshot.value, "");
  store.dispose();
});

// --- AC9: debounce coalesces rapid edits into one write -------------------

test("AC9: rapid setValue calls issue exactly one set after the debounce", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, callsOf } = createFakeHost();
    const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
    callsOf("get")[0].resolve(undefined);
    await flush();

    store.setValue("a");
    store.setValue("ab");
    store.setValue("abc");
    assert.equal(callsOf("set").length, 0);

    mock.timers.tick(150);
    await flush();

    assert.equal(callsOf("set").length, 1);
    assert.equal(callsOf("set")[0].args.value, "abc");
    store.dispose();
  } finally {
    mock.timers.reset();
  }
});

// --- AC10/AC11: writerId scoping -------------------------------------------

test("AC10: panel writes and subscribes with its own surfaceId (panelId)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, callsOf, subscribers } = createFakeHost();
    const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
    assert.equal(subscribers[0].filter.writerId, "panel-1");

    callsOf("get")[0].resolve(undefined);
    await flush();

    store.setValue("hi");
    mock.timers.tick(150);
    await flush();

    assert.equal(callsOf("set")[0].args.options.writerId, "panel-1");
    store.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("AC11: the kanban modal surface uses the bare id 'note-modal' as its writerId", () => {
  const { host, jsxCalls } = createFakeHost();
  const NoteModalContent = makeNoteModalContent(host, "task-42");
  NoteModalContent();

  assert.equal(jsxCalls.length, 1);
  assert.equal(jsxCalls[0].props.taskId, "task-42");
  assert.equal(jsxCalls[0].props.surfaceId, "note-modal");
});

// The kanban modal surface shares the exact same markdown editor as the
// task panel (see the file header and makeNoteModalContent's own comment):
// there is no more editorKind/RichTextEditor branch. presentation: "modal"
// is the only signal NotesEditor needs to give the modal its fixed-height
// container (AC: fixed modal size with scrollable textarea) instead of the
// panel's height: 100%.
test("the kanban modal surface uses presentation 'modal', the same NotesEditor as the panel", () => {
  const { host, jsxCalls } = createFakeHost();
  const NoteModalContent = makeNoteModalContent(host, "task-42");
  NoteModalContent();

  assert.equal(jsxCalls.length, 1);
  assert.equal(jsxCalls[0].props.presentation, "modal");
  assert.equal(jsxCalls[0].props.editorKind, undefined);
});

test("openNoteModal opens a modal bound to the given taskId, with or without a title", () => {
  const { host, openModalCalls, jsxCalls } = createFakeHost();

  openNoteModal(host, "task-1");
  assert.equal(openModalCalls[0].title, "Edit notes");
  assert.equal(openModalCalls[0].size, "xl");

  openNoteModal(host, "task-2", "Card Two");
  assert.equal(openModalCalls[1].title, "Edit notes — Card Two");

  // Both calls must bind to their own taskId, not share state.
  openModalCalls[0].content();
  openModalCalls[1].content();
  assert.equal(jsxCalls[0].props.taskId, "task-1");
  assert.equal(jsxCalls[1].props.taskId, "task-2");
});

// --- AC12: ifUnmodifiedSince tracks the latest updatedAt -------------------

test("AC12: every set carries ifUnmodifiedSince from the last successful get/set", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, callsOf } = createFakeHost();
    const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
    callsOf("get")[0].resolve({ value: "orig", updatedAt: "u1" });
    await flush();

    store.setValue("edit 1");
    mock.timers.tick(150);
    await flush();
    assert.equal(callsOf("set")[0].args.options.ifUnmodifiedSince, "u1");
    callsOf("set")[0].resolve({ updatedAt: "u2" });
    await flush();

    store.setValue("edit 2");
    mock.timers.tick(150);
    await flush();
    assert.equal(callsOf("set")[1].args.options.ifUnmodifiedSince, "u2");
    store.dispose();
  } finally {
    mock.timers.reset();
  }
});

// --- AC13: conflict handling ------------------------------------------------

test("AC13: a 409 conflict preserves the local edit, stops the queue, and refreshes updatedAt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, callsOf } = createFakeHost();
    const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
    callsOf("get")[0].resolve({ value: "orig", updatedAt: "u1" });
    await flush();

    store.setValue("my edit");
    mock.timers.tick(150);
    await flush();
    assert.equal(callsOf("set").length, 1);
    callsOf("set")[0].reject(new PluginStorageConflictError());
    await flush();

    // The conflict path issues a refresh({preserveValue:true}) — resolve it.
    assert.equal(callsOf("get").length, 2);
    callsOf("get")[1].resolve({ value: "someone else's edit", updatedAt: "u2" });
    await flush();

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.value, "my edit", "local edit must survive the conflict");
    assert.equal(snapshot.conflict, true);

    // The queue is stopped: further debounce ticks issue no new write.
    mock.timers.tick(1000);
    await flush();
    assert.equal(callsOf("set").length, 1, "no automatic retry after a conflict");

    store.retryWrite();
    await flush();
    assert.equal(callsOf("get").length, 3);
    callsOf("get")[2].resolve({ value: "someone else's edit", updatedAt: "u2" });
    await flush();
    mock.timers.tick(150);
    await flush();
    assert.equal(callsOf("set").length, 2, "retryWrite re-schedules the preserved edit");
    assert.equal(callsOf("set")[1].args.value, "my edit");
    assert.equal(callsOf("set")[1].args.options.ifUnmodifiedSince, "u2");
    store.dispose();
  } finally {
    mock.timers.reset();
  }
});

// --- AC14: a failed read never marks the panel loaded ----------------------

test("AC14: a failed get leaves the store unloaded, in an explicit retry state", async () => {
  const { host, callsOf } = createFakeHost();
  const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
  callsOf("get")[0].reject(new Error("network error"));
  await flush();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.loaded, false);
  assert.equal(snapshot.readError, true);
  store.dispose();
});

// --- AC15: generation counter + synchronous taskId switch ------------------

test("AC15: two out-of-order get resolutions commit only the newer one", async () => {
  const { host, callsOf } = createFakeHost();
  const store = createNoteStore(host, { taskId: "t1", surfaceId: "panel-1" });
  const firstGet = callsOf("get")[0];

  // A subscribe-triggered refresh starts a second, overlapping read.
  const secondRefresh = store.retryRead();
  const secondGet = callsOf("get")[1];
  assert.ok(secondGet && secondGet !== firstGet);

  // Resolve the newer read first.
  secondGet.resolve({ value: "second", updatedAt: "u2" });
  await secondRefresh;
  await flush();
  assert.equal(store.getSnapshot().value, "second");

  // The stale, older read resolving afterward must not win.
  firstGet.resolve({ value: "first", updatedAt: "u1" });
  await flush();
  assert.equal(store.getSnapshot().value, "second", "stale read must not overwrite the newer one");
  store.dispose();
});

test("AC15: switching taskId clears value/updatedAt synchronously", async () => {
  const { host, callsOf } = createFakeHost();
  const store = createNoteStore(host, { taskId: "task-A", surfaceId: "panel-1" });
  const getForA = callsOf("get")[0];
  assert.equal(getForA.args.scopeId, "task-A");

  store.setTaskId("task-B");
  // Synchronous: cleared before task-B's read has any chance to resolve.
  assert.equal(store.getSnapshot().value, "");
  assert.equal(store.getSnapshot().loaded, false);

  const getForB = callsOf("get")[1];
  assert.equal(getForB.args.scopeId, "task-B");

  // task-A's stale read resolving after the switch must be ignored.
  getForA.resolve({ value: "leaked from A", updatedAt: "uA" });
  await flush();
  assert.equal(store.getSnapshot().value, "");

  getForB.resolve({ value: "task B note", updatedAt: "uB" });
  await flush();
  assert.equal(store.getSnapshot().value, "task B note");
  store.dispose();
});

// --- AC16: kanban run(context) binds to context.taskId, not global state --

test("AC16: run() closures are independent per invocation (no shared global task)", () => {
  const { host, openModalCalls, jsxCalls } = createFakeHost();
  const registry = createFakeRegistry();
  registeredPlugin.initialize(registry, host);
  const { run } = registry.registerTaskMenuActionCalls[0];

  run({ taskId: "task-1", taskTitle: "Card One", workspaceId: "w", workflowStepId: null, presentation: "desktop" });
  run({ taskId: "task-2", taskTitle: "Card Two", workspaceId: "w", workflowStepId: null, presentation: "desktop" });

  assert.equal(openModalCalls.length, 2);
  assert.match(openModalCalls[0].title, /Card One/);
  assert.match(openModalCalls[1].title, /Card Two/);
  assert.notEqual(openModalCalls[0].content, openModalCalls[1].content);

  openModalCalls[0].content();
  openModalCalls[1].content();
  const surfaceCalls = jsxCalls.filter((c) => c.props.surfaceId === "note-modal");
  assert.equal(surfaceCalls.length, 2);
  assert.equal(surfaceCalls[0].props.taskId, "task-1");
  assert.equal(surfaceCalls[1].props.taskId, "task-2");
});

test("AC16 (visible): the menu action is hidden without a taskId", () => {
  const { host } = createFakeHost();
  const registry = createFakeRegistry();
  registeredPlugin.initialize(registry, host);
  const { visible } = registry.registerTaskMenuActionCalls[0];
  assert.equal(visible({ taskId: "" }), false);
  assert.equal(visible({ taskId: "t1" }), true);
});

// --- AC17: card-indicator cache: at most one get per taskId ----------------

test("AC17: a second lookup for the same taskId serves from cache, no new get", async () => {
  disposeNoteIndicatorSubscription();
  const { host, callsOf } = createFakeHost();
  const first = getCachedHasNote(host, "task-9");
  callsOf("get")[0].resolve({ value: "hello", updatedAt: "u1" });
  assert.equal(await first, true);

  const second = getCachedHasNote(host, "task-9");
  assert.equal(await second, true);
  assert.equal(callsOf("get").length, 1, "second lookup must not issue a new get");
});

test("AC17: concurrent first lookups for the same taskId dedupe into one get", async () => {
  const { host, callsOf } = createFakeHost();
  const a = getCachedHasNote(host, "task-dedupe");
  const b = getCachedHasNote(host, "task-dedupe");
  assert.equal(callsOf("get").length, 1);
  callsOf("get")[0].resolve({ value: "x", updatedAt: "u1" });
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test("subscribeCache notifies listeners for that taskId until unsubscribed", () => {
  const notifications = [];
  const unsubscribe = subscribeCache("task-notify", (hasNote) => notifications.push(hasNote));

  markNote("task-notify", true);
  markNote("task-notify", false);
  unsubscribe();
  markNote("task-notify", true);

  assert.deepEqual(notifications, [true, false]);
});

test("AC17/AC18: a cross-tab delete notification clears the cached indicator without a get", async () => {
  const fake = createFakeHost();
  initNoteIndicatorSubscription(fake.host);

  const primed = getCachedHasNote(fake.host, "task-del");
  fake.callsOf("get")[0].resolve({ value: "note", updatedAt: "u1" });
  assert.equal(await primed, true);

  fake.emit({ scope: "task", scopeId: "task-del", key: "note", updatedAt: "u2", deleted: true });
  assert.equal(await getCachedHasNote(fake.host, "task-del"), false);
  assert.equal(fake.callsOf("get").length, 1, "the cross-tab update must not issue a refetch");
  disposeNoteIndicatorSubscription();
});

// --- AC18: emptying a note updates the indicator to false ------------------

test("AC18: committing an empty value marks the indicator false; non-empty marks it true", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, callsOf } = createFakeHost();
    const committed = [];
    const store = createNoteStore(host, {
      taskId: "task-empty",
      surfaceId: "panel-1",
      onCommit: (hasNote) => committed.push(hasNote),
    });
    callsOf("get")[0].resolve(undefined);
    await flush();

    store.setValue("something");
    mock.timers.tick(150);
    await flush();
    callsOf("set")[0].resolve({ updatedAt: "u1" });
    await flush();
    assert.deepEqual(committed, [true]);

    store.setValue("");
    mock.timers.tick(150);
    await flush();
    callsOf("set")[1].resolve({ updatedAt: "u2" });
    await flush();
    assert.deepEqual(committed, [true, false]);
    store.dispose();
  } finally {
    mock.timers.reset();
  }
});

// --- AC19: initialize() idempotency + destroy() cleanup --------------------

test("AC19: initialize() called twice leaves exactly one module-level subscription", () => {
  const { host, subscribers } = createFakeHost();
  const registry = createFakeRegistry();
  registeredPlugin.initialize(registry, host);
  registeredPlugin.initialize(registry, host);
  const noteSubscribers = subscribers.filter((s) => s.filter.key === "note" && !s.filter.scopeId);
  assert.equal(noteSubscribers.length, 1);
});

test("AC19: destroy() unsubscribes, clears the indicator cache, and clears pending debounce timers", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { host, subscribers, callsOf } = createFakeHost();
    const registry = createFakeRegistry();
    registeredPlugin.initialize(registry, host);

    markNote("task-cached", true);
    assert.equal(await getCachedHasNote(host, "task-cached"), true);
    assert.equal(callsOf("get").length, 0, "cache already had this taskId");

    const store = createNoteStore(host, { taskId: "task-pending-write", surfaceId: "panel-x" });
    callsOf("get")[0].resolve(undefined);
    await flush();
    store.setValue("about to be dropped");

    registeredPlugin.destroy();

    const noteSubscribers = subscribers.filter((s) => s.filter.key === "note" && !s.filter.scopeId);
    assert.equal(noteSubscribers.length, 0, "destroy must unsubscribe the module-level subscription");

    mock.timers.tick(1000);
    await flush();
    assert.equal(callsOf("set").length, 0, "destroy must clear the pending debounce timer");

    // Cache was cleared: a lookup for the previously-cached taskId now
    // requires a real get again.
    const getsBeforeLookup = callsOf("get").length;
    const afterDestroy = getCachedHasNote(host, "task-cached");
    assert.equal(callsOf("get").length, getsBeforeLookup + 1);
    callsOf("get").at(-1).resolve(undefined);
    assert.equal(await afterDestroy, false);
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Markdown transforms (AC3: toolbar actions insert/wrap the correct markdown
// around the selection, or at the caret with no selection, and return an
// updated selection).
// ---------------------------------------------------------------------------

test("applyBold wraps a selection in ** markers and keeps it selected", () => {
  const text = "hello world";
  // select "world"
  const result = applyBold(text, 6, 11);
  assert.equal(result.value, "hello **world**");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "world");
});

test("applyBold with no selection inserts a placeholder wrapped in ** and selects it", () => {
  const result = applyBold("hello ", 6, 6);
  assert.equal(result.value, "hello **bold text**");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "bold text");
});

test("applyItalic wraps a selection in * markers", () => {
  const result = applyItalic("hi there", 3, 8);
  assert.equal(result.value, "hi *there*");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "there");
});

test("applyInlineCode wraps a selection in backticks", () => {
  const result = applyInlineCode("run npm test now", 4, 12);
  assert.equal(result.value, "run `npm test` now");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "npm test");
});

test("applyInlineCode with no selection inserts a `code` placeholder", () => {
  const result = applyInlineCode("", 0, 0);
  assert.equal(result.value, "`code`");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "code");
});

test("applyCodeBlock wraps a selection in a fenced code block", () => {
  const result = applyCodeBlock("const x = 1;", 0, 12);
  assert.equal(result.value, "```\nconst x = 1;\n```");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "const x = 1;");
});

test("applyCodeBlock with no selection inserts a placeholder fenced block", () => {
  const result = applyCodeBlock("", 0, 0);
  assert.equal(result.value, "```\ncode\n```");
});

test("applyLink wraps the selection as link text and selects the url placeholder", () => {
  const result = applyLink("see docs here", 4, 8);
  assert.equal(result.value, "see [docs](https://) here");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "https://");
});

test("applyLink with no selection inserts placeholder link text and selects the url", () => {
  const result = applyLink("", 0, 0);
  assert.equal(result.value, "[link text](https://)");
  assert.equal(result.value.slice(result.selStart, result.selEnd), "https://");
});

test("applyHeading prepends a level-2 heading marker to the current line", () => {
  const result = applyHeading("todo list", 3, 3);
  assert.equal(result.value, "## todo list");
});

test("applyHeading toggles the same level back off", () => {
  const once = applyHeading("todo list", 0, 0);
  const twice = applyHeading(once.value, once.selStart, once.selEnd);
  assert.equal(twice.value, "todo list");
});

test("applyHeading replaces a different existing heading level", () => {
  const result = applyHeading("# title", 2, 2, 3);
  assert.equal(result.value, "### title");
});

test("applyHeading only affects the line containing the caret in a multi-line note", () => {
  const text = "first line\nsecond line\nthird line";
  const caretInSecondLine = text.indexOf("second") + 2;
  const result = applyHeading(text, caretInSecondLine, caretInSecondLine);
  assert.equal(result.value, "first line\n## second line\nthird line");
});

test("applyBulletList prefixes every non-blank selected line with '- '", () => {
  const text = "milk\neggs\nbread";
  const result = applyBulletList(text, 0, text.length);
  assert.equal(result.value, "- milk\n- eggs\n- bread");
});

test("applyBulletList toggles the marker back off when every line already has it", () => {
  const text = "- milk\n- eggs";
  const result = applyBulletList(text, 0, text.length);
  assert.equal(result.value, "milk\neggs");
});

test("applyBulletList at a bare caret (no selection) only affects that line", () => {
  const text = "just one line";
  const result = applyBulletList(text, 4, 4);
  assert.equal(result.value, "- just one line");
});

test("applyBulletList skips blank lines within the selection", () => {
  const text = "milk\n\neggs";
  const result = applyBulletList(text, 0, text.length);
  assert.equal(result.value, "- milk\n\n- eggs");
});

test("applyNumberedList prefixes every non-blank selected line with sequential numbers", () => {
  const text = "milk\neggs\nbread";
  const result = applyNumberedList(text, 0, text.length);
  assert.equal(result.value, "1. milk\n2. eggs\n3. bread");
});

test("applyNumberedList toggles the marker back off when every line already has it", () => {
  const text = "1. milk\n2. eggs";
  const result = applyNumberedList(text, 0, text.length);
  assert.equal(result.value, "milk\neggs");
});

// ---------------------------------------------------------------------------
// enhanceNote — the "Enhance with AI" client (AC5/AC6/AC7).
// ---------------------------------------------------------------------------

function fakeApiHost(fetchImpl) {
  return { api: { fetch: fetchImpl } };
}

function fakeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("enhanceNote posts the note content to webhooks/enhance and returns the improved content", async () => {
  let capturedPath;
  let capturedInit;
  const host = fakeApiHost(async (path, init) => {
    capturedPath = path;
    capturedInit = init;
    return fakeJsonResponse(200, { content: "improved markdown" });
  });

  const result = await enhanceNote(host, "raw markdown");
  assert.equal(result, "improved markdown");
  assert.equal(capturedPath, "webhooks/enhance");
  assert.equal(capturedInit.method, "POST");
  assert.equal(JSON.parse(capturedInit.body).content, "raw markdown");
});

test("enhanceNote maps a 412 response to a distinguishable notConfigured error", async () => {
  const host = fakeApiHost(async () =>
    fakeJsonResponse(412, { error: "no utility agent is configured for this plugin" }),
  );

  await assert.rejects(
    () => enhanceNote(host, "raw markdown"),
    (error) => {
      assert.equal(error.notConfigured, true);
      assert.match(error.message, /utility agent/);
      return true;
    },
  );
});

test("enhanceNote surfaces other non-2xx statuses as a generic (non-notConfigured) error", async () => {
  const host = fakeApiHost(async () => fakeJsonResponse(502, { error: "AI enhancement failed" }));

  await assert.rejects(
    () => enhanceNote(host, "raw markdown"),
    (error) => {
      assert.equal(error.notConfigured, false);
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test("enhanceNote surfaces a network failure (fetch rejecting) as a non-notConfigured error", async () => {
  const host = fakeApiHost(async () => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(
    () => enhanceNote(host, "raw markdown"),
    (error) => {
      assert.equal(error.notConfigured, false);
      return true;
    },
  );
});

test("enhanceNote rejects when the success response is missing a content field", async () => {
  const host = fakeApiHost(async () => fakeJsonResponse(200, {}));

  await assert.rejects(() => enhanceNote(host, "raw markdown"));
});

// ---------------------------------------------------------------------------
// enhancePreviewReducer — the preview/Accept/Discard state machine.
// ---------------------------------------------------------------------------

test("enhancePreviewReducer: start -> success -> accept returns to idle, preview held in between", () => {
  let state = initialEnhanceState;
  assert.equal(state.status, "idle");

  state = enhancePreviewReducer(state, { type: "start" });
  assert.equal(state.status, "loading");

  state = enhancePreviewReducer(state, { type: "success", content: "better note" });
  assert.equal(state.status, "preview");
  assert.equal(state.preview, "better note");

  state = enhancePreviewReducer(state, { type: "accept" });
  assert.equal(state.status, "idle");
});

test("enhancePreviewReducer: discard returns to idle without carrying the preview forward", () => {
  let state = enhancePreviewReducer(initialEnhanceState, { type: "start" });
  state = enhancePreviewReducer(state, { type: "success", content: "better note" });
  state = enhancePreviewReducer(state, { type: "discard" });
  assert.equal(state.status, "idle");
  assert.equal(state.preview, undefined);
});

test("enhancePreviewReducer: failure carries the message and notConfigured flag; dismiss returns to idle", () => {
  let state = enhancePreviewReducer(initialEnhanceState, { type: "start" });
  state = enhancePreviewReducer(state, {
    type: "failure",
    message: "No utility agent is configured for this plugin yet.",
    notConfigured: true,
  });
  assert.equal(state.status, "error");
  assert.equal(state.notConfigured, true);
  assert.match(state.message, /utility agent/);

  state = enhancePreviewReducer(state, { type: "dismiss" });
  assert.equal(state.status, "idle");
});
