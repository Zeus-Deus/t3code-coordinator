import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  appendNote,
  BRIEF,
  buildTree,
  coordinatorStatus,
  decodeCoordinators,
  GUIDE,
  groupWorkers,
  isWorker,
  MEMORY_LIMITS,
  projectSection,
  overview,
  TREE_LIMITS,
  workerState,
} from "../lib/coordinator.mjs";

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
const delegated = (id, parent = "c", extra = {}) =>
  thread(id, {
    creationSource: "mcp",
    lineage: {
      parentThreadId: parent,
      relationshipToParent: "subagent",
      rootThreadId: parent,
    },
    ...extra,
  });

NodeTest.test(
  "workers are the coordinator's own delegations and launches, nothing else",
  () => {
    NodeAssert.ok(isWorker(delegated("task"), "c"));
    NodeAssert.ok(
      isWorker(thread("launched", { launchedFrom: { threadId: "c" } }), "c"),
    );
    NodeAssert.ok(
      !isWorker(delegated("helper", "c", { creationSource: "provider" }), "c"),
    );
    NodeAssert.ok(!isWorker(delegated("nested", "task"), "c"));
    NodeAssert.ok(!isWorker(thread("c"), "c"));
    NodeAssert.ok(
      !isWorker(
        thread("fork", {
          lineage: { parentThreadId: "c", relationshipToParent: "fork" },
        }),
        "c",
      ),
    );
    NodeAssert.ok(!isWorker(thread("unrelated"), "c"));
  },
);

NodeTest.test(
  "attention outranks running, and a person's unsettle beats an old settle",
  () => {
    NodeAssert.equal(
      workerState(thread("a", { isRunning: true, needsAttention: true })),
      "waiting",
    );
    NodeAssert.equal(workerState(thread("a", { isRunning: true })), "working");
    NodeAssert.equal(
      workerState(thread("a", { settledAt: "2026-10-01" })),
      "done",
    );
    NodeAssert.equal(
      workerState(thread("a", { settledOverride: "settled" })),
      "done",
    );
    NodeAssert.equal(
      workerState(
        thread("a", { settledAt: "2026-10-01", settledOverride: "active" }),
      ),
      "ready",
    );
    NodeAssert.equal(workerState(thread("a")), "ready");
  },
);

NodeTest.test(
  "groups skip archived workers and keep creation order as activity changes",
  () => {
    const groups = groupWorkers(
      [
        delegated("second", "c", {
          createdAt: "2026-10-02T00:00:00Z",
          updatedAt: "2026-10-01",
        }),
        delegated("first", "c", {
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-24",
        }),
        delegated("gone", "c", { archivedAt: "2026-10-02" }),
      ],
      "c",
    );
    NodeAssert.deepEqual(
      groups.ready.map((t) => t.id),
      ["first", "second"],
    );
  },
);

NodeTest.test(
  "the coordinator's status leads with what is waiting on the person",
  () => {
    const many = (state, n) =>
      Array.from({ length: n }, (_, i) => ({ id: `${state}${i}` }));
    const idle = { waiting: [], working: [], ready: [], done: [] };
    NodeAssert.deepEqual(
      coordinatorStatus({
        ...idle,
        waiting: many("n", 1),
        working: many("w", 2),
      }),
      { label: "1 waiting on you", tone: "warning" },
    );
    const busy = coordinatorStatus({
      ...idle,
      working: many("w", 12),
      ready: many("r", 12),
    });
    NodeAssert.deepEqual(busy, {
      label: "12 working · 12 ready for review",
      tone: "info",
    });
    NodeAssert.ok(busy.label.length <= 40);
    NodeAssert.equal(
      coordinatorStatus({ ...idle, ready: many("r", 2) }).tone,
      "success",
    );
    NodeAssert.deepEqual(coordinatorStatus(idle), {
      label: "No workers yet",
      tone: "neutral",
    });
    NodeAssert.equal(
      coordinatorStatus({ ...idle, done: [{}] }).label,
      "All workers done",
    );
    NodeAssert.deepEqual(
      coordinatorStatus({ ...idle, done: [{}] }, { needsAttention: true }),
      {
        label: "1 waiting on you",
        tone: "warning",
      },
    );
  },
);

NodeTest.test(
  "the Overview lists only groups with threads, in Claude Code Projects' order",
  () => {
    const view = overview(
      [
        thread("c"),
        delegated("done", "c", { settledAt: "2026-10-01" }),
        delegated("run", "c", { isRunning: true }),
        delegated("ask", "c", { needsAttention: true }),
        delegated("other", "x", { isRunning: true }),
      ],
      "c",
    );
    NodeAssert.deepEqual(
      view.groups.map((g) => [g.title, g.threads.map((t) => t.threadId)]),
      [
        ["Waiting on you", ["ask"]],
        ["Working", ["run"]],
        ["Done", ["done"]],
      ],
    );
    NodeAssert.deepEqual(view.status, {
      label: "1 waiting on you",
      tone: "warning",
    });
  },
);

NodeTest.test(
  "finished workers stay in place until they would bury the rest",
  () => {
    const workers = Array.from({ length: TREE_LIMITS.inlineDone + 2 }, (_, i) =>
      delegated(`w${i}`, "c", {
        createdAt: `2026-10-25T0${i}:00:00Z`,
        settledAt: i === 3 ? null : "2026-10-25T10:00:00Z",
      }),
    );
    const section = projectSection("p", [thread("c"), ...workers], "c");
    // Six settled: the oldest one folds into Done; the rest keep their start order with the open one.
    NodeAssert.deepEqual(
      section.done.map((t) => t.id),
      ["w0"],
    );
    NodeAssert.deepEqual(
      section.workers.map((t) => t.id),
      ["w1", "w2", "w3", "w4", "w5", "w6"],
    );
    const { nodes } = buildTree([section]);
    const done = nodes.find((node) => node.kind === "group");
    NodeAssert.deepEqual(
      { title: done.title, collapsedByDefault: done.collapsedByDefault },
      { title: "Done", collapsedByDefault: true },
    );
    NodeAssert.equal(
      done.parentId,
      nodes.find((node) => node.threadId === "c").id,
    );
    NodeAssert.equal(
      nodes.find((node) => node.threadId === "w0").parentId,
      done.id,
    );
  },
);

NodeTest.test(
  "a finished worker still waiting on the person never folds into Done",
  () => {
    const settled = { settledAt: "2026-10-25T10:00:00Z" };
    const workers = Array.from({ length: TREE_LIMITS.inlineDone + 1 }, (_, i) =>
      delegated(`w${i}`, "c", {
        createdAt: `2026-10-25T0${i}:00:00Z`,
        ...settled,
      }),
    );
    workers[0].needsAttention = true;
    const section = projectSection("p", [thread("c"), ...workers], "c");
    NodeAssert.deepEqual(section.done, []);
  },
);

NodeTest.test(
  "a coordinator too large to place leaves its whole branch to T3",
  () => {
    const workers = Array.from({ length: TREE_LIMITS.nodes + 10 }, (_, i) =>
      delegated(`w${i}`, "c", { settledAt: "2026-10-25T10:00:00Z" }),
    );
    const { nodes } = buildTree([
      projectSection("p", [thread("c"), ...workers], "c"),
    ]);
    // Placing the coordinator without its Done group would pull every omitted worker under it.
    NodeAssert.deepEqual(
      nodes.map((node) => node.kind),
      ["project"],
    );
  },
);

NodeTest.test(
  "other threads join their project only while they are live and top level",
  () => {
    const section = projectSection(
      "p",
      [
        thread("old", { updatedAt: "2026-10-01T00:00:00Z" }),
        thread("new", { updatedAt: "2026-10-24T00:00:00Z" }),
        thread("settled", { settledAt: "2026-10-02T00:00:00Z" }),
        thread("snoozed", { snoozedUntil: "2026-10-30T00:00:00Z" }),
        thread("gone", { archivedAt: "2026-10-02T00:00:00Z" }),
        thread("fork", {
          lineage: { parentThreadId: "old", relationshipToParent: "fork" },
        }),
      ],
      undefined,
      Date.parse("2026-10-25T00:00:00Z"),
    );
    NodeAssert.equal(section.coordinator, null);
    NodeAssert.deepEqual(
      section.others.map((t) => t.id),
      ["new", "old"],
    );
  },
);

NodeTest.test(
  "memory refuses to grow past its budget instead of dropping old decisions",
  () => {
    let memory = { version: 1, notes: [] };
    for (let i = 0; i < MEMORY_LIMITS.notes; i++)
      memory = appendNote(memory, {
        id: `n${i}`,
        text: "x",
        threadId: "t",
        createdAt: "",
      });
    NodeAssert.equal(appendNote(memory, { id: "n0", text: "x" }), memory);
    NodeAssert.throws(
      () => appendNote(memory, { id: "n0", text: "else" }),
      /different note/,
    );
    NodeAssert.throws(
      () => appendNote(memory, { id: "extra", text: "x" }),
      /memory is full/,
    );
  },
);

NodeTest.test(
  "stored data from an unknown version is refused, not overwritten",
  () => {
    NodeAssert.deepEqual(decodeCoordinators(null), {
      version: 1,
      projects: {},
    });
    NodeAssert.throws(
      () => decodeCoordinators({ version: 2, projects: {} }),
      /unknown format/,
    );
  },
);

NodeTest.test(
  "the first message stays short and hands off to the guide",
  () => {
    NodeAssert.ok(BRIEF.length <= 120, `${BRIEF.length} characters`);
    NodeAssert.match(BRIEF, /coordinator guide/);
    for (const tool of [
      "delegate_task",
      "memory-read",
      "memory-append",
      "t3_thread_organize",
    ])
      NodeAssert.ok(GUIDE.includes(tool), tool);
    NodeAssert.match(GUIDE, /ask what this project should accomplish/);
  },
);
