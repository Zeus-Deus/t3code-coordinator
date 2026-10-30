import * as NodeAssert from "node:assert/strict";
import * as NodeFs from "node:fs";
import * as NodeTest from "node:test";
import * as NodeVm from "node:vm";
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
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: id,
  },
  ...extra,
});
const delegated = (id, parent, extra = {}) =>
  thread(id, {
    creationSource: "mcp",
    lineage: {
      parentThreadId: parent,
      relationshipToParent: "subagent",
      rootThreadId: parent,
    },
    ...extra,
  });

/**
 * A fake host keeping the rules the plugin relies on: a deleted thread reads as permission
 * denied, pages are capped at 200, and every host call counts toward the invocation budget.
 */
function host({
  projects = [{ id: "p", title: "Demo" }],
  threads = [],
  capabilities = [],
  projectPageSize = 200,
} = {}) {
  const state = {
    storage: new Map(),
    threads: new Map(threads.map((t) => [t.id, t])),
    created: [],
    unarchived: [],
    invalidated: [],
    calls: 0,
    deniedProjects: new Set(),
    failedProjects: new Set(),
    threadLists: [],
    projectListingFailsAt: null,
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
    capabilities,
    signal: new AbortController().signal,
    storage: {
      get: counted(async (key) =>
        structuredClone(state.storage.get(key) ?? null),
      ),
      set: counted(
        async (key, value) =>
          void state.storage.set(key, structuredClone(value)),
      ),
      delete: counted(async (key) => void state.storage.delete(key)),
    },
    threads: {
      metadata: counted(async ({ threadId }) => {
        const found = state.threads.get(threadId);
        if (!found || found.deleted || state.deniedProjects.has(found.projectId))
          throw Object.assign(new Error("Permission denied."), {
            reason: "permission_denied",
          });
        return structuredClone(found);
      }),
      list: counted(async ({ projectId, cursor = 0, limit }) => {
        NodeAssert.ok(limit <= 200);
        state.threadLists.push(projectId);
        if (state.deniedProjects.has(projectId) || state.failedProjects.has(projectId))
          throw Object.assign(new Error("Project unavailable."), {
            reason: "permission_denied",
          });
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
        state.threads.set(
          threadId,
          thread(threadId, {
            projectId: input.projectId,
            ...(input.owner
              ? {
                  pluginOwner: {
                    installationId: "self",
                    treeId: input.owner.slice(5),
                  },
                }
              : {}),
          }),
        );
        return { threadId };
      }),
      adopt: counted(async ({ threadId, owner }) => {
        state.threads.get(threadId).pluginOwner = {
          installationId: "self",
          treeId: owner.slice(5),
        };
        return { threadId };
      }),
      unarchive: counted(async ({ threadId }) => {
        state.unarchived.push(threadId);
        state.threads.get(threadId).archivedAt = null;
        return { threadId };
      }),
    },
    projects: {
      list: counted(async ({ cursor = 0, limit }) => {
        NodeAssert.ok(limit <= 200);
        if (cursor === state.projectListingFailsAt)
          throw new Error("Project listing failed.");
        const visible = projects.filter((p) => !state.deniedProjects.has(p.id));
        const end = cursor + Math.min(limit, projectPageSize);
        return {
          projects: structuredClone(visible.slice(cursor, end)),
          nextCursor: end < visible.length ? end : null,
        };
      }),
    },
    ui: {
      invalidate: async (topics) => void state.invalidated.push(...topics),
    },
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

const start = (h, threadId) =>
  h.invoke("action:coordinator", {}, client(threadId));

NodeTest.test(
  "opening twice keeps one coordinator, started in default mode",
  async () => {
    const h = host({ threads: [thread("here", { interactionMode: "plan" })] });
    const first = await start(h, "here");
    const again = await start(h, "here");
    NodeAssert.equal(h.state.created.length, 1);
    // The Overview opens beside a new coordinator once; later opens just show the thread.
    NodeAssert.deepEqual(first.intents, [
      { type: "view.open", viewId: "overview", threadId: "coordinator-1" },
    ]);
    NodeAssert.deepEqual(again.intents, [
      { type: "thread.reveal", threadId: "coordinator-1" },
    ]);
    const [request] = h.state.created;
    NodeAssert.equal(request.title, "Coordinator");
    NodeAssert.equal(request.interactionMode, "default");
    NodeAssert.match(request.text, /coordinator guide/);
    NodeAssert.deepEqual(h.state.invalidated, [
      "tree:projects",
      "view:overview",
      "status:overview",
    ]);
  },
);

NodeTest.test(
  "a project in context wins over the open thread's project",
  async () => {
    const h = host({
      projects: [
        { id: "p", title: "Demo" },
        { id: "q", title: "Other" },
      ],
      threads: [thread("elsewhere", { projectId: "q" })],
    });
    // The sidebar row belongs to project p while a thread in q is open.
    await h.invoke(
      "action:coordinator",
      {},
      {
        ...client("elsewhere"),
        context: { threadId: "elsewhere", projectId: "p" },
      },
    );
    NodeAssert.equal(h.state.created[0].projectId, "p");
  },
);

NodeTest.test(
  "a deleted coordinator is replaced, but an archived one is never replaced behind your back",
  async () => {
    const h = host({ threads: [thread("here")] });
    await start(h, "here");
    h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
    const read = await h.invoke("status:overview", {}, client("coordinator-1"));
    NodeAssert.equal(read.data, null);
    // Without the Projects view there is no way to restore it, so the person is told where to.
    const archived = await start(h, "here");
    NodeAssert.match(archived.message, /Archive/);
    NodeAssert.equal(h.state.created.length, 1);
    h.state.threads.get("coordinator-1").deleted = true;
    await start(h, "here");
    NodeAssert.equal(h.state.created.length, 2);
  },
);

NodeTest.test("any agent can read the coordinator guide", async () => {
  const h = host({ threads: [thread("worker")] });
  const result = await h.invoke("action:guide", {}, agent("worker"));
  NodeAssert.match(result.message, /delegate_task/);
});

NodeTest.test("opening without a project explains itself", async () => {
  const h = host();
  const result = await h.invoke(
    "action:coordinator",
    {},
    { ...client(), context: {} },
  );
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
    await h.invoke(
      "action:memory-append",
      { text: "Use pnpm." },
      agent("worker", "retry-me"),
    );
    await h.invoke(
      "action:memory-append",
      { text: "Use pnpm." },
      agent("worker", "retry-me"),
    );
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
      h.invoke(
        "action:memory-read",
        {},
        { signal, operationId: "x", caller: { kind: "agent" } },
      ),
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
  await h.invoke(
    "view:overview:forget",
    { id: added.data.notes[0].id },
    client("here"),
  );
  NodeAssert.deepEqual(h.state.invalidated, ["view:overview"]);
});

NodeTest.test(
  "the panel only calls handlers the bridge accepts and the plugin registers",
  () => {
    const html = NodeFs.readFileSync(
      new URL("../views/overview.html", import.meta.url),
      "utf8",
    );
    const names = [...html.matchAll(/call\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    const h = host();
    NodeAssert.deepEqual(names.toSorted(), ["forget", "read", "remember"]);
    for (const name of names) {
      // The client bridge prefixes `view:<id>:` itself and rejects any other shape.
      NodeAssert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
      NodeAssert.ok(h.handlers.has(`view:overview:${name}`), name);
    }
    // The view's sandbox has no allow-forms, so a submit handler would never run.
    NodeAssert.doesNotMatch(html, /<form/);
  },
);

NodeTest.test(
  "the Overview chip sums up the project on the coordinator and its threads",
  async () => {
    const h = host({ threads: [thread("here"), thread("bystander")] });
    await start(h, "here");
    h.state.threads.set(
      "busy",
      delegated("busy", "coordinator-1", { isRunning: true }),
    );
    h.state.threads.set(
      "blocked",
      delegated("blocked", "coordinator-1", { needsAttention: true }),
    );
    const status = async (id) =>
      (await h.invoke("status:overview", {}, client(id))).data;
    const waiting = { label: "Accessible: 1 waiting on you", tone: "warning" };
    NodeAssert.deepEqual(await status("coordinator-1"), waiting);
    NodeAssert.deepEqual(await status("busy"), waiting);
    NodeAssert.equal(await status("bystander"), null);
    // The coordinator's own question counts alongside its threads'.
    h.state.threads.get("coordinator-1").needsAttention = true;
    NodeAssert.equal((await status("busy")).label, "Accessible: 2 waiting on you");
    h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
    NodeAssert.equal(await status("coordinator-1"), null);
    NodeAssert.equal(await status("busy"), null);
  },
);

NodeTest.test(
  "the coordinator's status warns when its count would be partial",
  async () => {
    const h = host({ threads: [thread("here")] });
    await start(h, "here");
    for (let i = 0; i < 2_001; i++)
      h.state.threads.set(`t${i}`, thread(`t${i}`));
    // Sorts after every filler page, the way a real worker id can.
    h.state.threads.set(
      "zz",
      delegated("zz", "coordinator-1", { isRunning: true }),
    );
    const result = await h.invoke(
      "status:overview",
      {},
      client("coordinator-1"),
    );
    NodeAssert.deepEqual(result.data, {
      label: "Partial scan · Open Overview",
      tone: "warning",
    });
  },
);

NodeTest.test(
  "the Overview groups the coordinator's threads and names the project",
  async () => {
    const h = host({ threads: [thread("here")] });
    await start(h, "here");
    h.state.threads.set(
      "busy",
      delegated("busy", "coordinator-1", { isRunning: true }),
    );
    h.state.threads.set(
      "other",
      delegated("other", "here", { isRunning: true }),
    );
    const { data } = await h.invoke("view:overview:read", {}, client("busy"));
    NodeAssert.equal(data.project, "Demo");
    NodeAssert.equal(data.current, "busy");
    NodeAssert.equal(data.overview.status.label, "1 working");
    NodeAssert.deepEqual(
      data.overview.groups.map((g) => [
        g.title,
        g.threads.map((t) => t.threadId),
      ]),
      [["Working", ["busy"]]],
    );
  },
);

NodeTest.test(
  "the Projects tree nests each worker under its coordinator, in start order",
  async () => {
    const h = host({
      projects: [
        { id: "p", title: "Demo" },
        { id: "q", title: "Alpha" },
      ],
      threads: [thread("here"), thread("elsewhere", { projectId: "q" })],
    });
    await start(h, "here");
    h.state.threads.set(
      "second",
      delegated("second", "coordinator-1", {
        createdAt: "2026-10-25T02:00:00Z",
        isRunning: true,
      }),
    );
    h.state.threads.set(
      "first",
      delegated("first", "coordinator-1", {
        createdAt: "2026-10-25T01:00:00Z",
      }),
    );
    const { nodes } = await h.tree();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const parentOf = (threadId) => {
      const node = nodes.find((candidate) => candidate.threadId === threadId);
      const parent = byId.get(node.parentId);
      return parent.kind === "project" ? parent.projectId : parent.threadId;
    };
    // Projects in title order; the coordinator leads its project and other live threads follow.
    NodeAssert.deepEqual(
      nodes.map((node) => node.projectId ?? node.threadId ?? node.title),
      ["q", "elsewhere", "p", "coordinator-1", "first", "second", "here"],
    );
    NodeAssert.equal(parentOf("coordinator-1"), "p");
    NodeAssert.equal(parentOf("first"), "coordinator-1");
    NodeAssert.equal(parentOf("here"), "p");
    NodeAssert.ok(nodes.every((node) => node.kind !== "group"));
  },
);

NodeTest.test(
  "the tree stays within the call budget and never lists an unlisted project",
  async () => {
    const projects = Array.from({ length: 120 }, (_, i) => ({
      id: `p${i}`,
      title: `P${i}`,
    }));
    const h = host({ projects });
    const calls = h.state.calls;
    const { nodes } = await h.tree();
    NodeAssert.ok(
      h.state.calls - calls <= 80,
      `${h.state.calls - calls} calls`,
    );
    NodeAssert.ok(nodes.length > 0);
  },
);

NodeTest.test(
  "where the host can, the project heading is the conversation, started empty on first click",
  async () => {
    const projects = [
      { id: "p", title: "Demo" },
      { id: "q", title: "Alpha" },
    ];
    const heading = async (h, projectId) =>
      (await h.tree()).nodes.find(
        (node) => node.kind === "project" && node.projectId === projectId,
      );
    const plain = host({ projects, threads: [thread("here")] });
    const legacy = await heading(plain, "p");
    NodeAssert.equal(legacy.actionId, undefined);
    NodeAssert.equal(legacy.threadId, undefined);
    const h = host({
      projects,
      threads: [thread("here")],
      capabilities: ["ui.native-tree-conversations"],
    });
    NodeAssert.equal((await heading(h, "p")).actionId, "open-conversation");
    // Reading the tree starts nothing; the click does.
    NodeAssert.equal(h.state.created.length, 0);
    const opened = await h.invoke(
      "action:open-conversation",
      {},
      { ...client(), context: { projectId: "p" } },
    );
    NodeAssert.deepEqual(opened.intents, [
      { type: "view.open", viewId: "overview", threadId: "coordinator-1" },
    ]);
    // Named after the project, with no first message: the brief waits for the person's own.
    const [request] = h.state.created;
    NodeAssert.equal(request.title, "Demo");
    NodeAssert.equal(request.text, undefined);
    NodeAssert.match(request.brief, /delegate_task/);
    NodeAssert.ok(request.brief.length <= 4000);
    const { nodes } = await h.tree();
    const p = nodes.find((node) => node.projectId === "p");
    NodeAssert.deepEqual(
      { threadId: p.threadId, actionId: p.actionId },
      { threadId: "coordinator-1", actionId: undefined },
    );
    // The conversation is the heading, never a row of its own.
    NodeAssert.ok(
      !nodes.some(
        (node) => node.threadId === "coordinator-1" && node.kind === "thread",
      ),
    );
    NodeAssert.equal((await heading(h, "q")).actionId, "open-conversation");
  },
);

NodeTest.test(
  "as its own view, Projects owns its conversations and brings back the same one when re-added",
  async () => {
    const projects = [
      { id: "p", title: "Demo" },
      { id: "q", title: "Alpha" },
    ];
    const capabilities = [
      "ui.native-tree-conversations",
      "ui.native-tree-projects",
    ];
    const h = host({ projects, threads: [thread("other")], capabilities });
    const add = (projectId) =>
      h.invoke(
        "action:new-project",
        {},
        { ...client(), context: { projectId } },
      );
    // Empty until a project is added; other threads stay in Activity.
    NodeAssert.deepEqual((await h.tree()).nodes, []);
    await add("p");
    NodeAssert.equal(h.state.created[0].owner, "tree:projects");
    let { nodes } = await h.tree();
    NodeAssert.deepEqual(
      nodes.map((n) => [n.kind, n.projectId ?? n.threadId]),
      [["project", "p"]],
    );
    // Removing is T3's archive; adding the project again restores that thread, not a new one.
    h.state.threads.get("coordinator-1").archivedAt = "2026-10-25T01:00:00Z";
    NodeAssert.deepEqual((await h.tree()).nodes, []);
    const again = await add("p");
    NodeAssert.deepEqual(h.state.unarchived, ["coordinator-1"]);
    NodeAssert.equal(h.state.created.length, 1);
    NodeAssert.deepEqual(again.intents, [
      { type: "thread.reveal", threadId: "coordinator-1" },
    ]);
    // A conversation created just before its id was stored is found, not duplicated.
    h.state.storage.delete("coordinators.v1");
    await add("p");
    NodeAssert.equal(h.state.created.length, 1);
    // Two candidates: the person chooses; nothing is started.
    h.state.threads.set(
      "stray",
      thread("stray", {
        projectId: "p",
        pluginOwner: { installationId: "self", treeId: "projects" },
      }),
    );
    h.state.storage.delete("coordinators.v1");
    const ambiguous = await add("p");
    NodeAssert.match(ambiguous.message, /more than one conversation/);
    NodeAssert.equal(h.state.created.length, 1);
  },
);

NodeTest.test(
  "a conversation from before the Projects view moves into it on the next tree read",
  async () => {
    const h = host({ threads: [thread("here")] });
    await start(h, "here");
    NodeAssert.equal(
      h.state.threads.get("coordinator-1").pluginOwner,
      undefined,
    );
    const upgraded = host({
      threads: [...h.state.threads.values()],
      capabilities: ["ui.native-tree-conversations", "ui.native-tree-projects"],
    });
    upgraded.state.storage = h.state.storage;
    await upgraded.tree();
    NodeAssert.equal(
      upgraded.state.threads.get("coordinator-1").pluginOwner.treeId,
      "projects",
    );
  },
);

const crossProjectHost = (options = {}) => {
  const h = host({
    projects: [
      { id: "p", title: "Coordinator repo" },
      { id: "q", title: "Worker repo" },
      { id: "r", title: "Restricted repo" },
    ],
    threads: [
      thread("c"),
      thread("cq", { projectId: "q" }),
      thread("launched", {
        projectId: "q",
        launchedFrom: { threadId: "c" },
        isRunning: true,
      }),
      delegated("direct", "c", { projectId: "q", needsAttention: true }),
      delegated("nested", "direct", { projectId: "q", isRunning: true }),
      thread("unrelated", { projectId: "q" }),
      thread("restricted", {
        projectId: "r",
        launchedFrom: { threadId: "c" },
        needsAttention: true,
      }),
      thread("archived", {
        projectId: "q",
        launchedFrom: { threadId: "c" },
        archivedAt: "2026-10-25T01:00:00Z",
      }),
    ],
    ...options,
  });
  h.state.storage.set("coordinators.v1", {
    version: 1,
    projects: { p: { threadId: "c" }, q: { threadId: "cq" } },
  });
  h.state.deniedProjects.add("r");
  return h;
};

NodeTest.test("Overview and status follow a cross-project worker's launcher, with live scoped counts", async () => {
  const h = crossProjectHost();
  for (const id of ["c", "launched", "direct"]) {
    const { data } = await h.invoke("view:overview:read", {}, client(id));
    NodeAssert.equal(data.project, "Coordinator repo");
    NodeAssert.deepEqual(data.coordinator, { threadId: "c" });
    NodeAssert.equal(data.current, id);
    NodeAssert.deepEqual(data.scan, { complete: true });
    NodeAssert.deepEqual(data.overview.groups.map((g) => [g.id, g.threads]), [
      ["waiting", [{ threadId: "direct", title: "direct", projectId: "q", project: "Worker repo" }]],
      ["working", [{ threadId: "launched", title: "launched", projectId: "q", project: "Worker repo" }]],
    ]);
    NodeAssert.deepEqual((await h.invoke("status:overview", {}, client(id))).data, {
      label: "Accessible: 1 waiting on you", tone: "warning",
    });
  }
  h.state.threads.get("direct").needsAttention = false;
  h.state.threads.get("direct").settledOverride = "settled";
  NodeAssert.equal((await h.invoke("status:overview", {}, client("launched"))).data.label,
    "Accessible: 1 working");
  NodeAssert.equal((await h.invoke("status:overview", {}, client("nested"))).data, null);
  NodeAssert.ok(!h.state.threadLists.includes("r"));
});

NodeTest.test("Projects scans worker projects without coordinators and places cross-project workers once", async () => {
  for (const exclusive of [false, true]) {
    const h = crossProjectHost({ capabilities: [
      "ui.native-tree-conversations", ...(exclusive ? ["ui.native-tree-projects"] : []),
    ] });
    delete h.state.storage.get("coordinators.v1").projects.q;
    const { nodes } = await h.tree();
    const coordinator = nodes.find((n) => n.threadId === "c");
    for (const id of ["launched", "direct"]) {
      const rows = nodes.filter((n) => n.threadId === id);
      NodeAssert.equal(rows.length, 1, `${id} appears once`);
      NodeAssert.equal(rows[0].parentId, coordinator.id);
    }
    NodeAssert.ok(!nodes.some((n) => n.threadId === "restricted" || n.projectId === "r"));
    NodeAssert.equal(nodes.some((n) => n.threadId === "unrelated"), !exclusive);
    NodeAssert.ok(!h.state.threadLists.includes("r"));
  }
});

NodeTest.test("workers of two coordinators stay under their launcher across project sections", async () => {
  const h = crossProjectHost({ capabilities: ["ui.native-tree-conversations", "ui.native-tree-projects"] });
  h.state.threads.set("reverse", thread("reverse", { launchedFrom: { threadId: "cq" } }));
  const { nodes } = await h.tree();
  for (const [id, parent] of [["launched", "c"], ["direct", "c"], ["reverse", "cq"]]) {
    const rows = nodes.filter((n) => n.threadId === id);
    NodeAssert.equal(rows.length, 1);
    NodeAssert.equal(rows[0].parentId, nodes.find((n) => n.threadId === parent).id);
  }
  const ids = nodes.filter((n) => n.threadId).map((n) => n.threadId);
  NodeAssert.equal(new Set(ids).size, ids.length);
});

NodeTest.test("worker Overview edits the same coordinator memory it displays; agent memory stays local", async () => {
  const h = crossProjectHost();
  const { data } = await h.invoke("view:overview:remember", { text: "Coordinator decision" }, client("launched"));
  for (const id of ["c", "launched"])
    NodeAssert.deepEqual((await h.invoke("view:overview:read", {}, client(id))).data.notes, data.notes);
  NodeAssert.deepEqual((await h.invoke("action:memory-read", {}, agent("launched"))).data.notes, []);
  await h.invoke("view:overview:forget", { id: data.notes[0].id }, client("launched"));
  NodeAssert.deepEqual((await h.invoke("view:overview:read", {}, client("c"))).data.notes, []);
});

NodeTest.test("a denied launcher is not replaced by the worker project's unrelated coordinator", async () => {
  const h = crossProjectHost();
  const added = await h.invoke("view:overview:remember", { text: "Restricted coordinator memory" }, client("c"));
  h.state.deniedProjects.add("p");
  NodeAssert.equal((await h.invoke("status:overview", {}, client("launched"))).data, null);
  const { data } = await h.invoke("view:overview:read", {}, client("launched"));
  NodeAssert.equal(data.coordinator, null);
  NodeAssert.deepEqual(data.notes, []);
  await h.invoke("view:overview:forget", { id: added.data.notes[0].id }, client("launched"));
  h.state.deniedProjects.delete("p");
  NodeAssert.deepEqual((await h.invoke("view:overview:read", {}, client("c"))).data.notes, added.data.notes);
  h.state.deniedProjects.add("p");
  const { nodes } = await h.tree();
  NodeAssert.ok(!nodes.some((n) => n.threadId === "c" || n.projectId === "p"));
});

NodeTest.test("a failed accessible-project scan exposes partial groups without claiming exact totals", async () => {
  const h = crossProjectHost();
  h.state.failedProjects.add("q");
  const { data } = await h.invoke("view:overview:read", {}, client("c"));
  NodeAssert.deepEqual(data.scan, { complete: false });
  NodeAssert.deepEqual(data.overview.groups, []);
  NodeAssert.deepEqual((await h.invoke("status:overview", {}, client("c"))).data, {
    label: "Partial scan · Open Overview", tone: "warning",
  });
});

NodeTest.test("project pagination and project-list failures are reflected in scan completeness", async () => {
  const h = crossProjectHost({ projectPageSize: 1 });
  let result = await h.invoke("view:overview:read", {}, client("c"));
  NodeAssert.deepEqual(result.data.scan, { complete: true });
  NodeAssert.equal(result.data.overview.groups.length, 2);
  h.state.projectListingFailsAt = 1;
  result = await h.invoke("view:overview:read", {}, client("c"));
  NodeAssert.deepEqual(result.data.scan, { complete: false });
  NodeAssert.deepEqual((await h.invoke("status:overview", {}, client("c"))).data, {
    label: "Partial scan · Open Overview", tone: "warning",
  });
});

NodeTest.test("Overview and status scans have a total call bound across many granted projects", async () => {
  const projects = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, title: `P${i}` }));
  const h = host({ projects, threads: [thread("c", { projectId: "p0" })] });
  h.state.storage.set("coordinators.v1", { version: 1, projects: { p0: { threadId: "c" } } });
  for (const name of ["view:overview:read", "status:overview"]) {
    const calls = h.state.calls;
    const { data } = await h.invoke(name, {}, client("c"));
    NodeAssert.ok(h.state.calls - calls <= 80);
    if (name.startsWith("view")) NodeAssert.deepEqual(data.scan, { complete: false });
    else NodeAssert.equal(data.label, "Partial scan · Open Overview");
  }
});

NodeTest.test("the panel shows working projects, accessible scope, partial counts and the launcher link", async () => {
  const html = NodeFs.readFileSync(new URL("../views/overview.html", import.meta.url), "utf8");
  const element = () => ({
    children: [], hidden: false, textContent: "", attributes: {}, listeners: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, handler) { this.listeners[key] = handler; },
  });
  const text = (node) => [node.textContent, ...node.children.map(text)].join(" ");
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const h = crossProjectHost();
  let refresh;
  const intents = [];
  NodeVm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: {
      getElementById: (id) => elements.get(id),
      createElement: element, createElementNS: element, addEventListener() {},
    },
    window: { t3: {
      invoke: (name, input) => h.invoke(`view:overview:${name}`, input, client("launched")),
      onContext: (handler) => { refresh = handler; },
      intent: async (intent) => { intents.push(intent); },
    } },
  });
  await refresh();
  NodeAssert.equal(elements.get("name").textContent, "Coordinator repo");
  NodeAssert.match(text(elements.get("groups")), /Worker repo/);
  NodeAssert.match(html.match(/id="scope">([^<]+)/)[1], /accessible projects/i);
  NodeAssert.equal(elements.get("threads").hidden, false);
  NodeAssert.equal(elements.get("partial").hidden, true);
  NodeAssert.equal(elements.get("back").hidden, false);
  elements.get("back").listeners.click();
  NodeAssert.equal(intents[0].threadId, "c");

  h.state.failedProjects.add("p");
  await refresh();
  NodeAssert.equal(elements.get("partial").hidden, false);
  NodeAssert.match(elements.get("summary").textContent, /partial/i);
  NodeAssert.match(text(elements.get("groups")), /1\+/);
  NodeAssert.equal(elements.get("no-threads").hidden, true);
  h.state.failedProjects.add("q");
  await refresh();
  NodeAssert.equal(elements.get("no-threads").hidden, true);
  NodeAssert.equal(elements.get("partial").hidden, false);
});
