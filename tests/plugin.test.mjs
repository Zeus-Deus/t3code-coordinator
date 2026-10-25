import * as NodeAssert from "node:assert/strict";
import * as NodeFs from "node:fs";
import * as NodeTest from "node:test";
import { activate } from "../plugin.mjs";

const thread = (id, extra = {}) => ({
  id,
  projectId: "p",
  title: id,
  updatedAt: "2026-10-25T00:00:00Z",
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  isRunning: false,
  needsAttention: false,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  ...extra,
});
const delegated = (id, parent, extra = {}) =>
  thread(id, {
    creationSource: "mcp",
    lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    ...extra,
  });

/**
 * A fake host keeping the rules the plugin relies on: a deleted thread reads as permission
 * denied, pages are capped at 200, and every host call counts toward the invocation budget.
 */
function host({ projects = [{ id: "p", title: "Demo" }], threads = [] } = {}) {
  const state = {
    storage: new Map(),
    threads: new Map(threads.map((t) => [t.id, t])),
    created: [],
    invalidated: [],
    calls: 0,
  };
  const handlers = new Map();
  let tree;
  const counted =
    (fn) =>
    async (...args) => {
      state.calls++;
      return fn(...args);
    };
  activate({
    capabilities: [],
    signal: new AbortController().signal,
    storage: {
      get: counted(async (key) => structuredClone(state.storage.get(key) ?? null)),
      set: counted(async (key, value) => void state.storage.set(key, structuredClone(value))),
      delete: counted(async (key) => void state.storage.delete(key)),
    },
    threads: {
      metadata: counted(async ({ threadId }) => {
        const found = state.threads.get(threadId);
        if (!found || found.deleted)
          throw Object.assign(new Error("Permission denied."), { reason: "permission_denied" });
        return structuredClone(found);
      }),
      list: counted(async ({ projectId, cursor = 0, limit }) => {
        NodeAssert.ok(limit <= 200);
        const rows = [...state.threads.values()]
          .filter((t) => t.projectId === projectId && !t.deleted)
          .sort((a, b) => a.id.localeCompare(b.id));
        return {
          threads: structuredClone(rows.slice(cursor, cursor + limit)),
          nextCursor: cursor + limit < rows.length ? cursor + limit : null,
        };
      }),
      create: counted(async (input) => {
        const threadId = `coordinator-${state.created.length + 1}`;
        state.created.push(input);
        state.threads.set(threadId, thread(threadId, { projectId: input.projectId }));
        return { threadId };
      }),
    },
    projects: { list: counted(async () => ({ projects, nextCursor: null })) },
    ui: { invalidate: async (topics) => void state.invalidated.push(...topics) },
    trees: { register: (_id, fn) => (tree = fn) },
    handle: (name, fn) => handlers.set(name, fn),
    log: () => {},
  });
  return {
    state,
    handlers,
    invoke: (name, input, invocation) => handlers.get(name)(input, invocation),
    tree: () => tree({ signal: new AbortController().signal }),
  };
}

let operation = 0;
const signal = new AbortController().signal;
const client = (threadId) => ({
  signal,
  operationId: `op-${++operation}`,
  caller: { kind: "client" },
  context: { threadId },
});
const agent = (threadId, operationId = `op-${++operation}`) => ({
  signal,
  operationId,
  caller: { kind: "agent", threadId },
});

const start = (h, threadId) => h.invoke("action:coordinator", {}, client(threadId));

NodeTest.test("opening twice keeps one coordinator, started in default mode", async () => {
  const h = host({ threads: [thread("here", { interactionMode: "plan" })] });
  const first = await start(h, "here");
  const again = await start(h, "here");
  NodeAssert.equal(h.state.created.length, 1);
  NodeAssert.deepEqual(first.intents, [{ type: "thread.reveal", threadId: "coordinator-1" }]);
  NodeAssert.deepEqual(again.intents, first.intents);
  const [request] = h.state.created;
  NodeAssert.equal(request.title, "Demo");
  NodeAssert.equal(request.interactionMode, "default");
  NodeAssert.match(request.text, /delegate_task/);
  NodeAssert.ok(h.state.invalidated.includes("tree:coordinator"));
});

NodeTest.test(
  "a project with no threads yet can start one, and the coordinator opens its panel",
  async () => {
    const h = host();
    const opened = await h.invoke("action:coordinator", {}, {
      ...client(),
      context: { projectId: "p" },
    });
    NodeAssert.deepEqual(opened.intents, [{ type: "thread.reveal", threadId: "coordinator-1" }]);
    NodeAssert.deepEqual((await start(h, "coordinator-1")).intents, [
      { type: "view.open", viewId: "coordinator" },
    ]);
  },
);

NodeTest.test("an archived or deleted coordinator is replaced on the next open", async () => {
  const h = host({ threads: [thread("here")] });
  await start(h, "here");
  h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
  const read = await h.invoke("view:coordinator:read", {}, client("here"));
  NodeAssert.equal(read.data.coordinator, null);
  await start(h, "here");
  h.state.threads.get("coordinator-2").deleted = true;
  await start(h, "here");
  NodeAssert.equal(h.state.created.length, 3);
});

NodeTest.test("opening without a project explains itself", async () => {
  const h = host();
  const result = await h.invoke("action:coordinator", {}, { ...client(), context: {} });
  NodeAssert.equal(result.message, "Select a project first.");
  NodeAssert.equal(h.state.created.length, 0);
});

NodeTest.test(
  "memory belongs to the verified caller's project and a retry adds nothing",
  async () => {
    const h = host({
      projects: [
        { id: "p", title: "Demo" },
        { id: "q", title: "Other" },
      ],
      threads: [thread("worker"), thread("elsewhere", { projectId: "q" })],
    });
    await h.invoke("action:memory-append", { text: "Use pnpm." }, agent("worker", "retry-me"));
    await h.invoke("action:memory-append", { text: "Use pnpm." }, agent("worker", "retry-me"));
    const own = await h.invoke("action:memory-read", {}, agent("worker"));
    NodeAssert.deepEqual(
      own.data.notes.map((n) => [n.text, n.threadId]),
      [["Use pnpm.", "worker"]],
    );
    // A target in context never redirects an agent to another project's memory.
    const other = await h.invoke("action:memory-read", {}, {
      ...agent("elsewhere"),
      context: { threadId: "worker", projectId: "p" },
    });
    NodeAssert.deepEqual(other.data.notes, []);
    await NodeAssert.rejects(
      h.invoke("action:memory-read", {}, { signal, operationId: "x", caller: { kind: "agent" } }),
      /agents running in a T3 thread/,
    );
  },
);

NodeTest.test("a person can add and remove notes from the panel", async () => {
  const h = host({ threads: [thread("here")] });
  const note = { text: "No new deps." };
  const added = await h.invoke("view:coordinator:remember", note, client("here"));
  NodeAssert.equal(added.data.notes.length, 1);
  const removed = await h.invoke(
    "view:coordinator:forget",
    { id: added.data.notes[0].id },
    client("here"),
  );
  NodeAssert.deepEqual(removed.data.notes, []);
});

NodeTest.test("removing a note refreshes other open panels", async () => {
  const h = host({ threads: [thread("here")] });
  const note = { text: "No new deps." };
  const added = await h.invoke("view:coordinator:remember", note, client("here"));
  h.state.invalidated.length = 0;
  await h.invoke("view:coordinator:forget", { id: added.data.notes[0].id }, client("here"));
  NodeAssert.deepEqual(h.state.invalidated, ["view:coordinator"]);
});

NodeTest.test("the panel only calls handlers the bridge accepts and the plugin registers", () => {
  const html = NodeFs.readFileSync(new URL("../views/coordinator.html", import.meta.url), "utf8");
  const names = [...html.matchAll(/call\("([^"]+)"/g)].map((match) => match[1]);
  const h = host();
  NodeAssert.deepEqual(names.toSorted(), ["forget", "read", "remember"]);
  for (const name of names) {
    // The client bridge prefixes `view:<id>:` itself and rejects any other shape.
    NodeAssert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
    NodeAssert.ok(h.handlers.has(`view:coordinator:${name}`), name);
  }
  // The view's sandbox has no allow-forms, so a submit handler would never run.
  NodeAssert.doesNotMatch(html, /<form/);
});

NodeTest.test("the status chip describes the coordinator and its workers only", async () => {
  const h = host({ threads: [thread("here"), thread("bystander")] });
  await start(h, "here");
  h.state.threads.set("busy", delegated("busy", "coordinator-1", { isRunning: true }));
  h.state.threads.set("blocked", delegated("blocked", "coordinator-1", { needsAttention: true }));
  h.state.threads.set(
    "launched",
    thread("launched", { launchedFrom: { threadId: "coordinator-1" } }),
  );
  const status = async (id) => (await h.invoke("status:coordinator", {}, client(id))).data;
  NodeAssert.deepEqual(await status("coordinator-1"), {
    label: "1 needs you · 1 working · 1 to review",
    tone: "warning",
  });
  NodeAssert.equal((await status("launched")).label, "Ready for review");
  NodeAssert.equal((await status("blocked")).tone, "warning");
  NodeAssert.equal(await status("bystander"), null);
  h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
  NodeAssert.equal(await status("launched"), null);
});

NodeTest.test("the coordinator's status stays hidden when its count would be partial", async () => {
  const h = host({ threads: [thread("here")] });
  await start(h, "here");
  for (let i = 0; i < 2_001; i++) h.state.threads.set(`t${i}`, thread(`t${i}`));
  // Sorts after every filler page, the way a real worker id can.
  h.state.threads.set("zz", delegated("zz", "coordinator-1", { isRunning: true }));
  const result = await h.invoke("status:coordinator", {}, client("coordinator-1"));
  NodeAssert.equal(result.data, null);
});

NodeTest.test(
  "the tree lists only live coordinators and stays within the call budget",
  async () => {
    const h = host({
      projects: [
        { id: "p", title: "Demo" },
        { id: "q", title: "Gone" },
      ],
      threads: [thread("here"), thread("there", { projectId: "q" })],
    });
    NodeAssert.deepEqual(await h.tree(), { nodes: [] });
    await start(h, "here");
    await start(h, "there");
    // A deleted coordinator and an ungranted project must not reach the snapshot.
    h.state.threads.get("coordinator-2").deleted = true;
    for (let i = 0; i < 10_000; i++) h.state.threads.set(`t${i}`, thread(`t${i}`));
    h.state.threads.set("w", delegated("w", "coordinator-1", { isRunning: true }));
    h.state.calls = 0;
    const { nodes } = await h.tree();
    NodeAssert.ok(h.state.calls < 100);
    NodeAssert.deepEqual(
      nodes.filter((n) => n.kind !== "group").map((n) => n.projectId ?? n.threadId),
      ["p", "coordinator-1", "w"],
    );
  },
);
