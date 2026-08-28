// Cross-version persistence contract for released Notes bundles.
//
// The real bundle from every published SemVer tag is loaded from Git. The
// shared storage double includes the registered plugin id in its namespace,
// just as Kandev plugin_user_state does, so changing the plugin id, scope,
// scope id, or key makes the round trip fail. Complete tag history is a
// required test input rather than an optional compatibility fixture.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const RELEASED_PLUGIN_ID = "kandev-plugin-notes";
const FIRST_TASK_NOTES_TAG = "v0.1.0";
const FIRST_WORKSPACE_NOTES_TAG = "v0.4.0";
const TEST_USER_ID = "notes-compat-user";
const NOTE_KEY = "note";

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch (error) {
    const detail = error && error.stderr ? String(error.stderr).trim() : String(error);
    throw new Error(
      "Notes persistence compatibility requires complete Git history: git " +
        args.join(" ") +
        " failed: " +
        detail,
    );
  }
}

function releaseTags() {
  return git("tag", "--list", "v*", "--sort=version:refname")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
}

function versionAtLeast(tag, baseline) {
  const left = tag.slice(1).split(".").map(Number);
  const right = baseline.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

async function loadBundle(label, source) {
  let registration = null;
  const previousWindow = globalThis.window;
  const previousRegister = globalThis.registerKandevPlugin;
  globalThis.window = globalThis;
  globalThis.registerKandevPlugin = (id, plugin) => {
    registration = { id, plugin };
  };

  try {
    // The label comment makes the URL unique even when HEAD is byte-identical
    // to the newest release.
    const encoded = Buffer.from(
      source + "\n// persistence-compat-source: " + label + "\n",
    ).toString("base64");
    const module = await import("data:text/javascript;base64," + encoded);
    assert.ok(registration, label + " did not register a Kandev plugin");
    assert.equal(
      typeof module.createNoteStore,
      "function",
      label + " does not export createNoteStore",
    );
    return { label, id: registration.id, plugin: registration.plugin, module };
  } finally {
    globalThis.window = previousWindow;
    globalThis.registerKandevPlugin = previousRegister;
  }
}

class PluginStorageConflictError extends Error {
  constructor() {
    super("plugin storage: value was modified since ifUnmodifiedSince");
    this.name = "PluginStorageConflictError";
  }
}

class PersistentUserState {
  #entries = new Map();
  #revision = 0;
  #subscribers = new Set();

  operations = [];

  #address(pluginId, userId, scope, scopeId, key) {
    return JSON.stringify([pluginId, userId, scope, scopeId, key]);
  }

  #record(method, pluginId, userId, scope, scopeId, key, extra = {}) {
    this.operations.push({ method, pluginId, userId, scope, scopeId, key, ...extra });
  }

  #notify(pluginId, userId, change, writerId) {
    for (const subscriber of this.#subscribers) {
      if (subscriber.pluginId !== pluginId || subscriber.userId !== userId) continue;
      const { filter } = subscriber;
      if (filter.scope && filter.scope !== change.scope) continue;
      if (filter.scopeId && filter.scopeId !== change.scopeId) continue;
      if (filter.key && filter.key !== change.key) continue;
      if (filter.writerId && filter.writerId === writerId) continue;
      subscriber.handler(change);
    }
  }

  host(pluginId, userId = TEST_USER_ID) {
    const state = this;
    return {
      storage: {
        async get(scope, scopeId, key) {
          state.#record("get", pluginId, userId, scope, scopeId, key);
          const address = state.#address(pluginId, userId, scope, scopeId, key);
          const entry = state.#entries.get(address);
          return entry ? { ...entry } : undefined;
        },
        async set(scope, scopeId, key, value, options = {}) {
          state.#record("set", pluginId, userId, scope, scopeId, key, { value, options });
          const address = state.#address(pluginId, userId, scope, scopeId, key);
          const existing = state.#entries.get(address);
          if (
            options.ifUnmodifiedSince !== undefined &&
            options.ifUnmodifiedSince !== (existing && existing.updatedAt)
          ) {
            throw new PluginStorageConflictError();
          }
          state.#revision += 1;
          const updatedAt = "compat-r" + state.#revision;
          state.#entries.set(address, { value, updatedAt });
          state.#notify(
            pluginId,
            userId,
            { scope, scopeId, key, updatedAt, deleted: false },
            options.writerId,
          );
          return { updatedAt };
        },
        async delete(scope, scopeId, key, options = {}) {
          state.#record("delete", pluginId, userId, scope, scopeId, key, { options });
          const address = state.#address(pluginId, userId, scope, scopeId, key);
          state.#entries.delete(address);
          state.#revision += 1;
          state.#notify(
            pluginId,
            userId,
            {
              scope,
              scopeId,
              key,
              updatedAt: "compat-r" + state.#revision,
              deleted: true,
            },
            options.writerId,
          );
        },
        async list() {
          return [];
        },
        subscribe(filter, handler) {
          const subscriber = { pluginId, userId, filter, handler };
          state.#subscribers.add(subscriber);
          return () => state.#subscribers.delete(subscriber);
        },
      },
      api: {
        async fetch(path) {
          throw new Error(
            "unexpected API probe during persistence compatibility test: " + path,
          );
        },
      },
    };
  }

  entry(pluginId, userId, scope, scopeId, key) {
    return this.#entries.get(this.#address(pluginId, userId, scope, scopeId, key));
  }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function storeOptions(bundle, scope, scopeId) {
  return {
    scope,
    scopeId,
    // v0.1.x/v0.2.x accepted taskId before scopeId was generalized.
    taskId: scope === "task" ? scopeId : undefined,
    surfaceId: "persistence-compat-" + bundle.label,
  };
}

async function openStore(bundle, state, scope, scopeId) {
  const store = bundle.module.createNoteStore(
    state.host(bundle.id),
    storeOptions(bundle, scope, scopeId),
  );
  await waitFor(
    () => store.getSnapshot().loaded,
    bundle.label + " did not finish loading " + scope + "/" + scopeId,
  );
  return store;
}

async function readNote(bundle, state, scope, scopeId) {
  const store = await openStore(bundle, state, scope, scopeId);
  const value = store.getSnapshot().value;
  store.dispose();
  bundle.plugin.destroy?.();
  return value;
}

async function writeNote(bundle, state, scope, scopeId, value) {
  const store = await openStore(bundle, state, scope, scopeId);
  const priorUpdatedAt = state.entry(
    bundle.id,
    TEST_USER_ID,
    scope,
    scopeId,
    NOTE_KEY,
  )?.updatedAt;
  store.setValue(value);
  await waitFor(() => {
    const entry = state.entry(bundle.id, TEST_USER_ID, scope, scopeId, NOTE_KEY);
    return entry && entry.value === value && entry.updatedAt !== priorUpdatedAt;
  }, bundle.label + " did not persist " + scope + "/" + scopeId);
  store.dispose();
  bundle.plugin.destroy?.();
}

function assertStorageContract(state, scope, scopeId) {
  const noteOperations = state.operations.filter((operation) => operation.method !== "list");
  assert.ok(noteOperations.length > 0, "compatibility scenario issued no storage operations");
  for (const operation of noteOperations) {
    assert.equal(
      operation.pluginId,
      RELEASED_PLUGIN_ID,
      "plugin id is part of the permanent storage namespace",
    );
    assert.equal(operation.userId, TEST_USER_ID);
    assert.equal(operation.scope, scope);
    assert.equal(operation.scopeId, scopeId);
    assert.equal(operation.key, NOTE_KEY);
  }
  assert.equal(
    noteOperations.filter((operation) => operation.method === "delete").length,
    0,
    "a version transition must never delete a note",
  );
}

const tags = releaseTags();
assert.ok(
  tags.includes(FIRST_TASK_NOTES_TAG),
  "required task-note baseline tag " + FIRST_TASK_NOTES_TAG + " is missing",
);
assert.ok(
  tags.includes(FIRST_WORKSPACE_NOTES_TAG),
  "required workspace-note baseline tag " + FIRST_WORKSPACE_NOTES_TAG + " is missing",
);

const releasedBundles = new Map();
for (const tag of tags) {
  releasedBundles.set(tag, await loadBundle(tag, git("show", tag + ":ui/bundle.js")));
}
const candidateBundle = await loadBundle(
  "working-tree",
  readFileSync(new URL("./bundle.js", import.meta.url), "utf8"),
);

test("all published and candidate bundles keep the released plugin identity", () => {
  assert.equal(candidateBundle.id, RELEASED_PLUGIN_ID);
  for (const [tag, bundle] of releasedBundles) {
    assert.equal(bundle.id, RELEASED_PLUGIN_ID, tag + " registered under an unexpected plugin id");
  }
});

for (const tag of tags) {
  test(tag + ": task notes survive upgrade to the candidate and downgrade back", async () => {
    const state = new PersistentUserState();
    const scopeId = "task-" + tag;
    const released = releasedBundles.get(tag);
    const historical = [
      "# Historical " + tag,
      "",
      "- [x] keep **all** markdown  ",
      "- owner: " + TEST_USER_ID,
      "- unicode: Café 東京 🚀",
      "",
    ].join("\r\n");
    const candidate = [
      "# Candidate edit for " + tag,
      "",
      "Inline code and Markdown stay byte-for-byte.",
      "",
      "    indented code",
      "trailing spaces  ",
      "unicode: naïve Привет 🌍",
    ].join("\n");

    await writeNote(released, state, "task", scopeId, historical);
    assert.equal(await readNote(candidateBundle, state, "task", scopeId), historical);

    await writeNote(candidateBundle, state, "task", scopeId, candidate);
    assert.equal(await readNote(released, state, "task", scopeId), candidate);

    assertStorageContract(state, "task", scopeId);
  });
}

for (const tag of tags.filter((candidate) => versionAtLeast(candidate, FIRST_WORKSPACE_NOTES_TAG))) {
  test(tag + ": workspace notes survive upgrade to the candidate and downgrade back", async () => {
    const state = new PersistentUserState();
    const scopeId = "workspace-" + tag;
    const released = releasedBundles.get(tag);
    const historical = [
      "## Workspace " + tag,
      "",
      "Persistent workspace idea.  ",
      "日本語 workspace note",
      "",
    ].join("\r\n");
    const candidate = [
      "## Candidate workspace edit",
      "",
      "Still present after " + tag + ".",
      "emoji: 📝",
    ].join("\n");

    await writeNote(released, state, "workspace", scopeId, historical);
    assert.equal(await readNote(candidateBundle, state, "workspace", scopeId), historical);

    await writeNote(candidateBundle, state, "workspace", scopeId, candidate);
    assert.equal(await readNote(released, state, "workspace", scopeId), candidate);

    assertStorageContract(state, "workspace", scopeId);
  });
}

test("a task-only downgrade hides but never deletes a workspace note", async () => {
  const state = new PersistentUserState();
  const scopeId = "workspace-through-task-only-release";
  const taskId = "task-opened-during-old-release";
  const workspaceBundle = releasedBundles.get(FIRST_WORKSPACE_NOTES_TAG);
  const taskOnlyBundle = releasedBundles.get(FIRST_TASK_NOTES_TAG);
  const content = "# Workspace note\r\n\r\nRecover me after the old release.  \r\n復元してください";

  await writeNote(workspaceBundle, state, "workspace", scopeId, content);

  // v0.1.0 has no workspace surface. Opening and unloading its task store
  // simulates the old plugin running without mutating the workspace row it
  // cannot display.
  assert.equal(await readNote(taskOnlyBundle, state, "task", taskId), "");
  assert.equal(await readNote(candidateBundle, state, "workspace", scopeId), content);

  assert.deepEqual(
    state.operations.filter((operation) => operation.method === "delete"),
    [],
  );
  const workspaceEntry = state.entry(
    RELEASED_PLUGIN_ID,
    TEST_USER_ID,
    "workspace",
    scopeId,
    NOTE_KEY,
  );
  assert.equal(workspaceEntry.value, content);
});
