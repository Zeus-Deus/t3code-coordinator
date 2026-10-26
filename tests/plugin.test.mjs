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
    handle: (name, fn) => handlers.set(name, fn),
    log: () => {},
  });
  return {
    state,
    handlers,
    invoke: (name, input, invocation) => handlers.get(name)(input, invocation),
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
  const open = [{ type: "view.open", viewId: "overview", threadId: "coordinator-1" }];
  NodeAssert.deepEqual(first.intents, open);
  NodeAssert.deepEqual(again.intents, open);
  const [request] = h.state.created;
  NodeAssert.equal(request.title, "Coordinator");
  NodeAssert.equal(request.interactionMode, "default");
  NodeAssert.match(request.text, /guide action/);
  NodeAssert.deepEqual(h.state.invalidated, ["view:overview", "status:overview"]);
});

NodeTest.test("a project with no threads yet can start one, opened with its Overview", async () => {
  const h = host();
  const opened = await h.invoke(
    "action:coordinator",
    {},
    { ...client(), context: { projectId: "p" } },
  );
  NodeAssert.deepEqual(opened.intents, [
    { type: "view.open", viewId: "overview", threadId: "coordinator-1" },
  ]);
});

NodeTest.test("an archived or deleted coordinator is replaced on the next open", async () => {
  const h = host({ threads: [thread("here")] });
  await start(h, "here");
  h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
  const read = await h.invoke("view:overview:read", {}, client("here"));
  NodeAssert.equal(read.data.coordinator, null);
  await start(h, "here");
  h.state.threads.get("coordinator-2").deleted = true;
  await start(h, "here");
  NodeAssert.equal(h.state.created.length, 3);
});

NodeTest.test("any agent can read the coordinator guide", async () => {
  const h = host({ threads: [thread("worker")] });
  const result = await h.invoke("action:guide", {}, agent("worker"));
  NodeAssert.match(result.message, /delegate_task/);
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
    const other = await h.invoke(
      "action:memory-read",
      {},
      {
        ...agent("elsewhere"),
        context: { threadId: "worker", projectId: "p" },
      },
    );
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
  const added = await h.invoke("view:overview:remember", note, client("here"));
  NodeAssert.equal(added.data.notes.length, 1);
  const removed = await h.invoke(
    "view:overview:forget",
    { id: added.data.notes[0].id },
    client("here"),
  );
  NodeAssert.deepEqual(removed.data.notes, []);
});

NodeTest.test("removing a note refreshes other open panels", async () => {
  const h = host({ threads: [thread("here")] });
  const note = { text: "No new deps." };
  const added = await h.invoke("view:overview:remember", note, client("here"));
  h.state.invalidated.length = 0;
  await h.invoke("view:overview:forget", { id: added.data.notes[0].id }, client("here"));
  NodeAssert.deepEqual(h.state.invalidated, ["view:overview"]);
});

NodeTest.test("the panel only calls handlers the bridge accepts and the plugin registers", () => {
  const html = NodeFs.readFileSync(new URL("../views/overview.html", import.meta.url), "utf8");
  const names = [...html.matchAll(/call\("([^"]+)"/g)].map((match) => match[1]);
  const h = host();
  NodeAssert.deepEqual(names.toSorted(), ["forget", "read", "remember"]);
  for (const name of names) {
    // The client bridge prefixes `view:<id>:` itself and rejects any other shape.
    NodeAssert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
    NodeAssert.ok(h.handlers.has(`view:overview:${name}`), name);
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
  const status = async (id) => (await h.invoke("status:overview", {}, client(id))).data;
  NodeAssert.deepEqual(await status("coordinator-1"), {
    label: "1 waiting on you",
    tone: "warning",
  });
  NodeAssert.equal((await status("launched")).label, "Ready for review");
  NodeAssert.equal((await status("blocked")).tone, "warning");
  NodeAssert.equal(await status("bystander"), null);
  h.state.threads.get("blocked").needsAttention = false;
  h.state.threads.get("busy").isRunning = false;
  h.state.threads.get("coordinator-1").needsAttention = true;
  NodeAssert.equal((await status("coordinator-1")).label, "Waiting on you");
  h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
  NodeAssert.equal(await status("launched"), null);
});

NodeTest.test("the coordinator's status stays hidden when its count would be partial", async () => {
  const h = host({ threads: [thread("here")] });
  await start(h, "here");
  for (let i = 0; i < 2_001; i++) h.state.threads.set(`t${i}`, thread(`t${i}`));
  // Sorts after every filler page, the way a real worker id can.
  h.state.threads.set("zz", delegated("zz", "coordinator-1", { isRunning: true }));
  const result = await h.invoke("status:overview", {}, client("coordinator-1"));
  NodeAssert.equal(result.data, null);
});

NodeTest.test("the overview groups this coordinator's threads and names the project", async () => {
  const h = host({ threads: [thread("here")] });
  await start(h, "here");
  h.state.threads.set("busy", delegated("busy", "coordinator-1", { isRunning: true }));
  h.state.threads.set("other", delegated("other", "here", { isRunning: true }));
  const { data } = await h.invoke("view:overview:read", {}, client("coordinator-1"));
  NodeAssert.equal(data.project, "Demo");
  NodeAssert.equal(data.isCoordinator, true);
  NodeAssert.deepEqual(
    data.overview.groups.map((g) => [g.id, g.threads.map((t) => t.threadId)]),
    [["working", ["busy"]]],
  );
  const fromWorker = await h.invoke("view:overview:read", {}, client("busy"));
  NodeAssert.equal(fromWorker.data.isCoordinator, false);
  NodeAssert.equal(fromWorker.data.coordinator.threadId, "coordinator-1");
});
