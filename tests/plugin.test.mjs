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
    sent: [],
    accessRequests: [],
    declinedProjects: new Set(),
    sendError: null,
    handler: null,
    caller: null,
    contextThreadId: null,
  };
  const denied = () =>
    Object.assign(new Error("Permission denied."), {
      reason: "permission_denied",
    });
  // The verified sender, as the host resolves it: nobody but an agent or a person's action has one.
  const sender = () =>
    state.caller?.kind === "agent"
      ? state.caller.threadId
      : state.handler?.startsWith("action:")
        ? state.contextThreadId
        : undefined;
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
        if (state.createError) throw state.createError;
        const threadId = `coordinator-${state.created.length + 1}`;
        state.created.push(input);
        // The host records the caller as the launcher, wherever the new thread lives.
        const launcher = sender();
        state.threads.set(
          threadId,
          thread(threadId, {
            projectId: input.projectId,
            ...(launcher ? { launchedFrom: { threadId: launcher } } : {}),
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
        if (state.caller?.kind !== "client") throw denied();
        state.unarchived.push(threadId);
        state.threads.get(threadId).archivedAt = null;
        return { threadId };
      }),
      send: counted(async (input) => {
        if (state.sendError) throw state.sendError;
        const target = state.threads.get(input.threadId);
        if (!target || target.deleted) throw denied();
        if (state.deniedProjects.has(target.projectId)) throw denied();
        const from = input.fromConversation ? sender() : undefined;
        if (input.fromConversation) {
          const source = state.threads.get(from);
          if (!source || state.deniedProjects.has(source.projectId))
            throw denied();
        }
        if (target.archivedAt) throw new Error("The thread is archived.");
        state.sent.push({ ...input, senderThreadId: from });
        return { threadId: input.threadId, runId: "run", delivery: "started" };
      }),
    },
    projects: {
      requestAccess: counted(async (request) => {
        if (!state.caller || state.handler?.startsWith("view:")) throw denied();
        if (!state.threads.get(request.threadId)?.pluginOwner) throw denied();
        state.accessRequests.push(request);
        if (!state.deniedProjects.has(request.projectId))
          return { status: "granted" };
        return {
          status: state.declinedProjects.has(request.projectId)
            ? "declined"
            : "pending",
        };
      }),
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
    invoke: async (name, input, invocation) => {
      state.handler = name;
      state.caller = invocation?.caller ?? null;
      state.contextThreadId = invocation?.context?.threadId;
      return handlers.get(name)(input, invocation);
    },
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
    const waiting = { label: "1 waiting on you", tone: "warning" };
    NodeAssert.deepEqual(await status("coordinator-1"), waiting);
    NodeAssert.deepEqual(await status("busy"), waiting);
    NodeAssert.equal(await status("bystander"), null);
    // The coordinator's own question counts alongside its threads'.
    h.state.threads.get("coordinator-1").needsAttention = true;
    NodeAssert.equal((await status("busy")).label, "2 waiting on you");
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
  "a device with no agent says what to do instead of the host's error",
  async () => {
    const h = host({
      projects: [{ id: "p", title: "Demo" }],
      capabilities: [
        "ui.native-tree-conversations",
        "ui.native-tree-projects",
      ],
    });
    const add = () =>
      h.invoke(
        "action:new-project",
        {},
        { ...client(), context: { projectId: "p" } },
      );
    h.state.createError = Object.assign(
      new Error("Thread creation requires a model selection."),
      { reason: "invalid_input" },
    );
    const { message, intents } = await add();
    NodeAssert.match(message, /Settings → Providers/);
    NodeAssert.equal(intents, undefined);
    // Any other failure stays the host's to report.
    h.state.createError = new Error("disk full");
    await NodeAssert.rejects(add(), /disk full/);
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
      label: "1 waiting on you", tone: "warning",
    });
  }
  h.state.threads.get("direct").needsAttention = false;
  h.state.threads.get("direct").settledOverride = "settled";
  NodeAssert.equal((await h.invoke("status:overview", {}, client("launched"))).data.label,
    "1 working");
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

NodeTest.test("without conversation headings a cross-project worker stays in its own project", async () => {
  const h = crossProjectHost();
  delete h.state.storage.get("coordinators.v1").projects.q;
  const { nodes } = await h.tree();
  const heading = (id) => nodes.find((n) => n.kind === "project" && n.projectId === id);
  NodeAssert.ok(!nodes.some((n) => n.kind === "project" && n.threadId));
  const launched = nodes.filter((n) => n.threadId === "launched");
  NodeAssert.deepEqual(launched.map((n) => n.parentId), [heading("q").id]);
  NodeAssert.ok(!nodes.some((n) => n.threadId === "direct"));
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

const HANDOFF_CAPABILITIES = [
  "ui.native-tree-conversations",
  "ui.native-tree-projects",
];

/** Shelf has a coordinator (coordinator-1); the plugin holds Atlas only once a person adds it. */
async function askingHost() {
  const h = host({
    projects: [
      { id: "p", title: "Shelf" },
      { id: "q", title: "Atlas" },
      { id: "r", title: "Harbor" },
    ],
    capabilities: HANDOFF_CAPABILITIES,
  });
  await h.invoke("action:new-project", {}, personIn({ projectId: "p" }));
  h.state.deniedProjects.add("q");
  return h;
}
const createdInAtlas = (h) =>
  h.state.created.filter((request) => request.projectId === "q");
const personIn = (context) => ({ ...client(), context });
const ask = (h, input = {}, invocation = agent("coordinator-1")) =>
  h.invoke(
    "action:ask-project",
    { projectId: "q", message: "Please add a health check.", ...input },
    invocation,
  );
/** What the host does when a person answers its card. */
const answer = (h, decision, projectId = "q", threadId = "coordinator-1") => {
  if (decision === "granted") h.state.deniedProjects.delete(projectId);
  else h.state.declinedProjects.add(projectId);
  return h.invoke(
    "action:project-access",
    { projectAccess: decision },
    personIn({ projectId, threadId }),
  );
};
const row = async (h, handoffId, threadId = "coordinator-1") =>
  (await h.invoke("view:asked:read", { handoffId }, client(threadId))).data;
const panel = async (h, threadId = "coordinator-1") =>
  (await h.invoke("view:overview:read", {}, client(threadId))).data;
const asked = (h) => h.state.sent.filter((m) => m.fromConversation);
const notes = (h) => h.state.sent.filter((m) => !m.fromConversation);
/** Grants Atlas and sends one message, leaving Atlas's new conversation as `target`. */
async function delivered(h, input) {
  h.state.deniedProjects.delete("q");
  const result = await ask(h, input);
  return { handoffId: result.data.handoffId, target: asked(h).at(-1).threadId };
}

NodeTest.test(
  "a message waits for the person's Add, then opens the project's conversation as the asker",
  async () => {
    const h = await askingHost();
    const result = await ask(h);
    NodeAssert.equal(result.data.status, "pending");
    NodeAssert.match(result.message, /card/);
    NodeAssert.deepEqual(h.state.sent, []);
    NodeAssert.deepEqual(createdInAtlas(h), []);
    NodeAssert.deepEqual(h.state.accessRequests, [
      {
        projectId: "q",
        threadId: "coordinator-1",
        actionId: "project-access",
      },
    ]);
    // The row is there from the first call, and names nothing the plugin can't read yet.
    NodeAssert.equal(result.card.viewId, "asked");
    NodeAssert.equal(result.card.summary, "Asked another project");
    const { handoffId } = result.card.data;
    NodeAssert.deepEqual(await row(h, handoffId), {
      title: "Asked another project",
      threadId: null,
      state: "sent",
      label: "Waiting for access",
    });

    await answer(h, "granted");
    const [created] = createdInAtlas(h);
    NodeAssert.equal(createdInAtlas(h).length, 1);
    NodeAssert.equal(created.projectId, "q");
    NodeAssert.equal(created.title, "Atlas");
    NodeAssert.equal(created.owner, "tree:projects");
    const [sent] = h.state.sent;
    NodeAssert.equal(h.state.sent.length, 1);
    NodeAssert.equal(sent.fromConversation, true);
    NodeAssert.equal(sent.senderThreadId, "coordinator-1");
    NodeAssert.match(sent.text, /^Please add a health check\./);
    NodeAssert.match(sent.text, new RegExp(`handoffId "${handoffId}"`));
    // A plugin's message doesn't carry the brief, so the guide is named here.
    NodeAssert.match(sent.text, /coordinator guide/);
    NodeAssert.deepEqual(await row(h, handoffId), {
      title: "Asked Atlas",
      threadId: sent.threadId,
      state: "sent",
      label: "Sent",
    });
    NodeAssert.ok(h.state.invalidated.includes("view:asked"));
    NodeAssert.ok(h.state.invalidated.includes("tree:projects"));
    // The person's answer needs no note: the row moved and the reply will arrive here.
    NodeAssert.deepEqual(notes(h), []);
  },
);

NodeTest.test("a project the plugin already holds gets the message at once", async () => {
  const h = await askingHost();
  h.state.deniedProjects.delete("q");
  const result = await ask(h);
  NodeAssert.equal(result.data.status, "sent");
  NodeAssert.equal(result.card.summary, "Asked Atlas");
  NodeAssert.equal(asked(h)[0].senderThreadId, "coordinator-1");
});

NodeTest.test(
  "Not now keeps the message out of the project and tells the agent plainly",
  async () => {
    const h = await askingHost();
    await ask(h);
    await answer(h, "declined");
    NodeAssert.deepEqual(asked(h), []);
    NodeAssert.deepEqual(createdInAtlas(h), []);
    // Woken with a plain note: the sender label is only for messages between projects.
    NodeAssert.equal(notes(h).length, 1);
    NodeAssert.equal(notes(h)[0].threadId, "coordinator-1");
    NodeAssert.match(notes(h)[0].text, /not now/);
    NodeAssert.match(notes(h)[0].text, /Tell them plainly/);

    const repeat = await ask(h);
    NodeAssert.match(repeat.message, /said not now/);
    NodeAssert.equal(repeat.data.status, "declined");
    NodeAssert.equal(repeat.card, undefined);
    NodeAssert.equal(asked(h).length, 0);

    // Once the person writes again the host opens the question, and the same ask works.
    h.state.declinedProjects.delete("q");
    const again = await ask(h);
    NodeAssert.equal(again.data.status, "pending");
    await answer(h, "granted");
    NodeAssert.equal(asked(h).length, 1);
  },
);

NodeTest.test(
  "the row and the store forget a declined message",
  async () => {
    const h = await askingHost();
    const { card } = await ask(h);
    await answer(h, "declined");
    NodeAssert.equal((await row(h, card.data.handoffId)).label, "Not added");
    NodeAssert.doesNotMatch(
      JSON.stringify(h.state.storage.get("handoffs.v1")),
      /health check/,
    );
  },
);

NodeTest.test("repeating an operationId adds no card and no second message", async () => {
  const h = await askingHost();
  const invocation = agent("coordinator-1", "same");
  const first = await ask(h, {}, invocation);
  const second = await ask(h, {}, invocation);
  NodeAssert.equal(second.data.handoffId, first.data.handoffId);
  NodeAssert.equal(second.card, undefined);
  await answer(h, "granted");
  const third = await ask(h, {}, invocation);
  NodeAssert.match(third.message, /already went out/);
  NodeAssert.equal(third.card, undefined);
  NodeAssert.equal(asked(h).length, 1);
});

NodeTest.test("the same words under a new operationId are a new request", async () => {
  const h = await askingHost();
  const first = await ask(h);
  const second = await ask(h);
  NodeAssert.notEqual(second.data.handoffId, first.data.handoffId);
  NodeAssert.ok(second.card);
  await answer(h, "granted");
  NodeAssert.equal(asked(h).length, 2);
  // Identical text after that goes out too: the earlier one is still unanswered.
  await ask(h);
  NodeAssert.equal(asked(h).length, 3);
});

NodeTest.test("different waiting messages go out in order, once", async () => {
  const h = await askingHost();
  await ask(h, { message: "First." });
  await ask(h, { message: "Second." });
  await answer(h, "granted");
  NodeAssert.deepEqual(
    asked(h).map((m) => m.text.split("\n")[0]),
    ["First.", "Second."],
  );
  NodeAssert.equal(createdInAtlas(h).length, 1);
});

NodeTest.test("an operationId sends once and can't change its message", async () => {
  const h = await askingHost();
  h.state.deniedProjects.delete("q");
  const invocation = agent("coordinator-1", "retry");
  const first = await ask(h, {}, invocation);
  const retry = await ask(h, {}, invocation);
  NodeAssert.equal(retry.data.handoffId, first.data.handoffId);
  NodeAssert.equal(asked(h).length, 1);
  await NodeAssert.rejects(
    ask(h, { message: "Something else." }, invocation),
    /already asked something else/,
  );
  await NodeAssert.rejects(
    ask(h, { projectId: "r" }, invocation),
    /already asked something else/,
  );
  NodeAssert.equal(asked(h).length, 1);
});

NodeTest.test(
  "a failed send keeps the message for a retry that delivers it once",
  async () => {
    const h = await askingHost();
    h.state.deniedProjects.delete("q");
    h.state.sendError = new Error("The plugin could not send to the thread.");
    const invocation = agent("coordinator-1", "flaky");
    const first = await ask(h, {}, invocation);
    NodeAssert.equal(first.data.status, "pending");
    NodeAssert.match(first.message, /hasn't gone out/);
    NodeAssert.equal((await row(h, first.data.handoffId)).label, "Not sent");
    h.state.sendError = null;
    const retry = await ask(h, {}, invocation);
    NodeAssert.equal(retry.data.status, "sent");
    NodeAssert.equal(asked(h).length, 1);
    NodeAssert.equal(createdInAtlas(h).length, 1);
  },
);

NodeTest.test(
  "a failed delivery after approval wakes the agent, since the answer's return value goes nowhere",
  async () => {
    const h = await askingHost();
    const invocation = agent("coordinator-1", "kept");
    await ask(h, {}, invocation);
    h.state.createError = Object.assign(new Error("No model selection."), {
      reason: "invalid_input",
    });
    await answer(h, "granted");
    NodeAssert.deepEqual(asked(h), []);
    NodeAssert.equal(notes(h).length, 1);
    NodeAssert.match(notes(h)[0].text, /hasn't gone out/);
    NodeAssert.match(notes(h)[0].text, /Settings → Providers/);
    h.state.createError = null;
    const retry = await ask(h, {}, invocation);
    NodeAssert.equal(retry.data.status, "sent");
    NodeAssert.equal(asked(h).length, 1);
  },
);

NodeTest.test(
  "the host's record decides, so a wrong answer input grants nothing",
  async () => {
    const h = await askingHost();
    await ask(h);
    // Still ungranted on the host, whatever the input claims.
    await h.invoke(
      "action:project-access",
      { projectAccess: "granted" },
      personIn({ projectId: "q", threadId: "coordinator-1" }),
    );
    NodeAssert.deepEqual(h.state.sent, []);
  },
);

NodeTest.test(
  "another conversation's message waits for its own sender after the answer",
  async () => {
    const h = await askingHost();
    await h.invoke("action:new-project", {}, personIn({ projectId: "r" }));
    const other = [...h.state.threads.values()].find((t) => t.projectId === "r");
    const harbor = agent(other.id, "from-harbor");
    await ask(h, { message: "From Harbor." }, harbor);
    await ask(h, { message: "From Shelf." });
    // The host moved the one request to the conversation that asked last.
    await answer(h, "granted");
    NodeAssert.equal(asked(h).length, 1);
    NodeAssert.match(asked(h)[0].text, /^From Shelf\./);
    NodeAssert.equal(asked(h)[0].senderThreadId, "coordinator-1");
    NodeAssert.equal(notes(h).length, 1);
    NodeAssert.equal(notes(h)[0].threadId, other.id);
    NodeAssert.match(notes(h)[0].text, /same projectId, message and operationId/);
    await ask(h, { message: "From Harbor." }, harbor);
    NodeAssert.equal(asked(h).at(-1).senderThreadId, other.id);
  },
);

NodeTest.test(
  "asks keep one conversation per project, through archived and deleted ones",
  async () => {
    const h = await askingHost();
    const { target } = await delivered(h);
    await ask(h, { message: "Second." });
    NodeAssert.equal(createdInAtlas(h).length, 1);
    NodeAssert.equal(asked(h)[1].threadId, target);

    // Only a person can restore a thread, so the agent is told who has to.
    h.state.threads.get(target).archivedAt = "2026-10-25T01:00:00Z";
    const invocation = agent("coordinator-1", "archived");
    const blocked = await ask(h, { message: "Third." }, invocation);
    NodeAssert.equal(blocked.data.status, "pending");
    NodeAssert.match(blocked.message, /New project/);
    NodeAssert.equal(createdInAtlas(h).length, 1);
    NodeAssert.deepEqual(h.state.unarchived, []);

    await h.invoke("action:new-project", {}, personIn({ projectId: "q" }));
    NodeAssert.deepEqual(h.state.unarchived, [target]);
    await ask(h, { message: "Third." }, invocation);
    NodeAssert.equal(asked(h)[2].threadId, target);

    h.state.threads.get(target).deleted = true;
    await ask(h, { message: "Fourth." });
    NodeAssert.equal(createdInAtlas(h).length, 2);
    NodeAssert.notEqual(asked(h)[3].threadId, target);
  },
);

NodeTest.test("an approval restores an archived conversation rather than duplicating it", async () => {
  const h = await askingHost();
  const { target } = await delivered(h);
  h.state.threads.get(target).archivedAt = "2026-10-25T01:00:00Z";
  h.state.deniedProjects.add("q");
  await ask(h, { message: "Back again." });
  await answer(h, "granted");
  NodeAssert.deepEqual(h.state.unarchived, [target]);
  NodeAssert.equal(createdInAtlas(h).length, 1);
  NodeAssert.equal(asked(h).at(-1).threadId, target);
});

NodeTest.test("only a project's main conversation asks, about another project", async () => {
  const h = await askingHost();
  h.state.threads.set(
    "worker",
    delegated("worker", "coordinator-1", { projectId: "p" }),
  );
  await NodeAssert.rejects(ask(h, {}, agent("worker")), /main conversation/);
  await NodeAssert.rejects(
    ask(h, {}, personIn({ threadId: "coordinator-1" })),
    /main conversation/,
  );
  await NodeAssert.rejects(ask(h, { projectId: "p" }), /this project/);
  await NodeAssert.rejects(ask(h, { projectId: "" }), /Name the project/);
  await NodeAssert.rejects(ask(h, { message: " " }), /needs text/);
  await NodeAssert.rejects(
    ask(h, { message: "x".repeat(4001) }),
    /under 4000 characters/,
  );
  NodeAssert.deepEqual(h.state.accessRequests, []);
});

NodeTest.test("a full store refuses a new ask rather than lose a reply route", async () => {
  const h = await askingHost();
  const { handoffId, target } = await delivered(h);
  const store = h.state.storage.get("handoffs.v1");
  const [first] = store.handoffs;
  for (let i = 1; i < 100; i++)
    store.handoffs.push({ ...first, id: `unanswered-${i}` });
  const refused = ask(h, { message: "One more." });
  await NodeAssert.rejects(refused, /still unanswered, so nothing was sent/);
  NodeAssert.equal(asked(h).length, 1);
  NodeAssert.equal(h.state.storage.get("handoffs.v1").handoffs.length, 100);
  // The oldest route still works, and its reply frees a place.
  await h.invoke("action:reply-project", { handoffId, message: "Done." }, agent(target));
  await ask(h, { message: "One more." });
  NodeAssert.equal(asked(h).length, 3);
  const stored = h.state.storage.get("handoffs.v1").handoffs;
  NodeAssert.equal(stored.length, 100);
  NodeAssert.ok(!stored.some((entry) => entry.id === handoffId));
});

NodeTest.test("waiting messages are bounded", async () => {
  const h = await askingHost();
  for (let i = 0; i < 10; i++) await ask(h, { message: `Message ${i}.` });
  await NodeAssert.rejects(
    ask(h, { message: "One too many." }),
    /Too many messages/,
  );
});

NodeTest.test(
  "a reply goes back to the conversation that asked, once, as its sender",
  async () => {
    const h = await askingHost();
    const { handoffId, target } = await delivered(h);
    const invocation = agent(target, "reply");
    const reply = { handoffId, message: "The health check is in." };
    await h.invoke("action:reply-project", reply, invocation);
    const [, back] = asked(h);
    NodeAssert.equal(back.threadId, "coordinator-1");
    NodeAssert.equal(back.senderThreadId, target);
    NodeAssert.match(back.text, /^The health check is in\./);
    NodeAssert.match(back.text, /nothing to acknowledge/);
    NodeAssert.ok(h.state.invalidated.includes("view:overview"));

    // A retry is a no-op; a second reply and a reply to the reply both stop here.
    await h.invoke("action:reply-project", reply, invocation);
    NodeAssert.equal(asked(h).length, 2);
    await NodeAssert.rejects(
      h.invoke(
        "action:reply-project",
        { handoffId, message: "Changed." },
        invocation,
      ),
      /different reply/,
    );
    await NodeAssert.rejects(
      h.invoke("action:reply-project", reply, agent(target)),
      /one reply/,
    );
    await NodeAssert.rejects(
      h.invoke("action:reply-project", reply, agent("coordinator-1")),
      /no ask with that handoffId/,
    );
    NodeAssert.equal(asked(h).length, 2);
  },
);

NodeTest.test(
  "a reply is refused without a stored handoff addressed to the caller",
  async () => {
    const h = await askingHost();
    const { card } = await ask(h);
    const { handoffId } = card.data;
    // Unsent, so nobody has been asked yet.
    await NodeAssert.rejects(
      h.invoke(
        "action:reply-project",
        { handoffId, message: "Hi." },
        agent("coordinator-1"),
      ),
      /no ask with that handoffId/,
    );
    await answer(h, "granted");
    h.state.threads.set("stranger", thread("stranger", { projectId: "r" }));
    for (const input of [
      { handoffId, message: "Hi." },
      { handoffId: "made-up", message: "Hi." },
      { threadId: "coordinator-1", message: "Hi." },
    ])
      await NodeAssert.rejects(
        h.invoke("action:reply-project", input, agent("stranger")),
        /no ask with that handoffId/,
      );
    await NodeAssert.rejects(
      h.invoke(
        "action:reply-project",
        { handoffId, message: "Hi." },
        personIn({ threadId: "coordinator-1" }),
      ),
      /main conversation/,
    );
    NodeAssert.equal(asked(h).length, 1);
  },
);

NodeTest.test(
  "the Overview's other projects come from the target conversation and its workers",
  async () => {
    const h = await askingHost();
    const before = await panel(h);
    NodeAssert.deepEqual(before.others, []);
    NodeAssert.equal(before.summary, "No workers yet");

    const { handoffId, target } = await delivered(h);
    h.state.threads.set(
      "shelf-worker",
      delegated("shelf-worker", "coordinator-1", { projectId: "p" }),
    );
    let data = await panel(h);
    NodeAssert.equal(data.summary, "1 ready for review · waiting on Atlas");
    NodeAssert.equal(data.others.length, 1);
    NodeAssert.deepEqual(
      (({ project, threadId, state, label, preview }) => ({
        project,
        threadId,
        state,
        label,
        preview,
      }))(data.others[0]),
      {
        project: "Atlas",
        threadId: target,
        state: "sent",
        label: "Sent",
        preview: "Please add a health check.",
      },
    );
    // Started by the ask, the conversation is Atlas's own, not one of Shelf's threads.
    NodeAssert.equal(h.state.threads.get(target).launchedFrom.threadId, "coordinator-1");
    NodeAssert.equal(data.overview.groups.length, 1);
    NodeAssert.deepEqual(
      data.overview.groups[0].threads.map((t) => t.threadId),
      ["shelf-worker"],
    );

    h.state.threads.get(target).isRunning = true;
    data = await panel(h);
    NodeAssert.equal(data.others[0].state, "working");
    NodeAssert.equal((await row(h, handoffId)).label, "Working");

    h.state.threads.get(target).isRunning = false;
    h.state.threads.set("atlas-worker", delegated("atlas-worker", target, {
      projectId: "q",
      isRunning: true,
    }));
    NodeAssert.equal((await panel(h)).others[0].state, "working");
    NodeAssert.equal((await row(h, handoffId)).title, "Asked Atlas");

    h.state.threads.get("atlas-worker").needsAttention = true;
    NodeAssert.equal((await panel(h)).others[0].state, "waiting");
    h.state.threads.delete("atlas-worker");

    await h.invoke(
      "action:reply-project",
      { handoffId, message: "Done on our side." },
      agent(target),
    );
    data = await panel(h);
    NodeAssert.equal(data.summary, "1 ready for review");
    NodeAssert.equal(data.others[0].state, "replied");
    NodeAssert.equal(data.others[0].preview, "Done on our side.");
    NodeAssert.deepEqual(data.others[0].history, [
      { who: "Asked", text: "Please add a health check." },
      { who: "Atlas", text: "Done on our side." },
    ]);
  },
);

NodeTest.test("a pending ask has no name to show, so the Overview waits for it", async () => {
  const h = await askingHost();
  await ask(h);
  const data = await panel(h);
  NodeAssert.deepEqual(data.others, []);
  NodeAssert.equal(data.summary, "No workers yet");
});

NodeTest.test("the subtitle stays short with several projects", async () => {
  const h = await askingHost();
  await delivered(h);
  NodeAssert.equal((await panel(h)).summary, "Waiting on Atlas");
  await h.invoke("action:new-project", {}, personIn({ projectId: "r" }));
  await ask(h, { projectId: "r", message: "Hello Harbor." });
  NodeAssert.match(
    (await panel(h)).summary,
    /^Waiting on (Atlas and Harbor|Harbor and Atlas)$/,
  );
});

NodeTest.test("revoking a project drops it from the Overview and neutralises its row", async () => {
  const h = await askingHost();
  const { handoffId } = await delivered(h);
  h.state.deniedProjects.add("q");
  const data = await panel(h);
  NodeAssert.deepEqual(data.others, []);
  NodeAssert.equal(data.summary, "No workers yet");
  NodeAssert.deepEqual(await row(h, handoffId), {
    title: "Asked another project",
    threadId: null,
    state: "sent",
    label: "No access",
  });
  NodeAssert.doesNotMatch(JSON.stringify(data), /Atlas|health check/);
});

NodeTest.test("a deleted target loses its link but keeps the history", async () => {
  const h = await askingHost();
  const { handoffId, target } = await delivered(h);
  h.state.threads.get(target).deleted = true;
  NodeAssert.equal((await panel(h)).others[0].threadId, null);
  NodeAssert.equal((await row(h, handoffId)).threadId, null);
});

NodeTest.test("messages between two projects never reach a third", async () => {
  const h = await askingHost();
  const { handoffId, target } = await delivered(h);
  await h.invoke(
    "action:reply-project",
    { handoffId, message: "Secret plan." },
    agent(target),
  );
  await h.invoke("action:new-project", {}, personIn({ projectId: "r" }));
  const harbor = [...h.state.threads.values()].find((t) => t.projectId === "r");
  const third = await panel(h, harbor.id);
  NodeAssert.deepEqual(third.others, []);
  NodeAssert.equal(third.overview.groups.length, 0);
  NodeAssert.equal(await row(h, handoffId, harbor.id), null);
  NodeAssert.equal(await row(h, handoffId, target), null);
  // The receiver's own panel doesn't show the asker's history either.
  NodeAssert.deepEqual((await panel(h, target)).others, []);
  // A worker Shelf started in Harbor opens Shelf's panel, but not Shelf's messages.
  h.state.threads.set(
    "harbor-worker",
    thread("harbor-worker", {
      projectId: "r",
      launchedFrom: { threadId: "coordinator-1" },
    }),
  );
  h.state.storage.get("coordinators.v1").projects.r = undefined;
  delete h.state.storage.get("coordinators.v1").projects.r;
  const worker = await panel(h, "harbor-worker");
  NodeAssert.equal(worker.projectId, "p");
  NodeAssert.deepEqual(worker.others, []);
  NodeAssert.doesNotMatch(JSON.stringify(worker), /Secret plan/);
});

NodeTest.test("the asker's row only reads in its own conversation, from stored state", async () => {
  const h = await askingHost();
  await delivered(h);
  NodeAssert.equal(await row(h, "made-up"), null);
  NodeAssert.equal(await row(h, undefined), null);
});

NodeTest.test("the Overview section is hidden when empty, and folds in place", async () => {
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
  const h = await askingHost();
  let refresh;
  const intents = [];
  NodeVm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: {
      getElementById: (id) => elements.get(id),
      createElement: element, createElementNS: element, addEventListener() {},
      createTextNode: (textContent) => ({ ...element(), textContent }),
    },
    window: { t3: {
      invoke: (name, input) => h.invoke(`view:overview:${name}`, input, client("coordinator-1")),
      onContext: (handler) => { refresh = handler; },
      intent: async (intent) => { intents.push(intent); },
    } },
  });
  await refresh();
  NodeAssert.equal(elements.get("others").hidden, true);

  const { handoffId, target } = await delivered(h);
  await h.invoke("action:reply-project", { handoffId, message: "All done." }, agent(target));
  await refresh();
  NodeAssert.equal(elements.get("others").hidden, false);
  NodeAssert.equal(elements.get("others-count").textContent, "1");
  NodeAssert.equal(elements.get("summary").textContent, "No workers yet");
  const rows = elements.get("other-rows");
  NodeAssert.equal(rows.children.length, 1);
  NodeAssert.equal(rows.children[0].attributes["aria-expanded"], "false");
  NodeAssert.match(text(rows), /Atlas\s+All done\./);

  rows.children[0].listeners.click();
  NodeAssert.equal(rows.children.length, 2);
  NodeAssert.equal(rows.children[0].attributes["aria-expanded"], "true");
  const expanded = text(rows.children[1]);
  NodeAssert.match(expanded, /Asked: \s*Please add a health check\./);
  NodeAssert.match(expanded, /Atlas: \s*All done\./);
  NodeAssert.match(expanded, /Open Atlas ›/);
  rows.children[1].children.at(-1).listeners.click();
  NodeAssert.equal(intents[0].threadId, target);

  rows.children[0].listeners.click();
  NodeAssert.equal(rows.children.length, 1);
});

NodeTest.test("the asked card reads its handoff and links to the conversation", async () => {
  const html = NodeFs.readFileSync(new URL("../views/asked.html", import.meta.url), "utf8");
  const element = () => ({
    textContent: "", hidden: true, disabled: true, className: "", listeners: {},
    addEventListener(key, handler) { this.listeners[key] = handler; },
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const h = await askingHost();
  const { handoffId, target } = await delivered(h);
  const intents = [];
  let invoked;
  NodeVm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: (id) => elements.get(id), addEventListener() {} },
    window: { t3: {
      context: { card: { summary: "Asked Atlas", data: { handoffId } } },
      invoke: (name, input) => (invoked = h.invoke(`view:asked:${name}`, input, client("coordinator-1"))),
      onContext() {},
      intent: async (intent) => { intents.push(intent); },
    } },
  });
  await invoked;
  await new Promise(setImmediate);
  NodeAssert.equal(elements.get("title").textContent, "Asked Atlas");
  NodeAssert.equal(elements.get("status").textContent, "· Sent");
  NodeAssert.equal(elements.get("row").disabled, false);
  NodeAssert.equal(elements.get("chevron").hidden, false);
  elements.get("row").listeners.click();
  NodeAssert.equal(intents[0].type, "thread.reveal");
  NodeAssert.equal(intents[0].threadId, target);
  NodeAssert.doesNotMatch(html, /<form/);
});

NodeTest.test("the manifest declares the handoff the host needs", () => {
  const manifest = JSON.parse(
    NodeFs.readFileSync(new URL("../t3-plugin.json", import.meta.url), "utf8"),
  );
  for (const capability of ["threads.send", "projects.request-access", "ui.conversation-cards"])
    NodeAssert.ok(manifest.capabilities.includes(capability), capability);
  NodeAssert.notEqual(manifest.version, "0.1.0");
  const action = (id) => manifest.actions.find((a) => a.id === id);
  NodeAssert.equal(action("ask-project").agentCallable, true);
  NodeAssert.equal(action("reply-project").agentCallable, true);
  // An agent calling it could pass off its own input as a person's answer.
  NodeAssert.ok(action("project-access"));
  NodeAssert.notEqual(action("project-access").agentCallable, true);
  NodeAssert.deepEqual(action("project-access").placements, []);
  const h = host();
  for (const { id } of manifest.actions)
    NodeAssert.ok(h.handlers.has(`action:${id}`), id);
  NodeAssert.equal(
    manifest.views.find((view) => view.id === "asked").placement,
    "conversation",
  );
});
