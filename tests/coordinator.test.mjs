import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  appendNote,
  BRIEF,
  coordinatorStatus,
  decodeCoordinators,
  GUIDE,
  groupWorkers,
  isWorker,
  MEMORY_LIMITS,
  overview,
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
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  ...extra,
});
const delegated = (id, parent = "c", extra = {}) =>
  thread(id, {
    creationSource: "mcp",
    lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    ...extra,
  });

NodeTest.test("workers are the coordinator's own delegations and launches, nothing else", () => {
  NodeAssert.ok(isWorker(delegated("task"), "c"));
  NodeAssert.ok(isWorker(thread("launched", { launchedFrom: { threadId: "c" } }), "c"));
  NodeAssert.ok(!isWorker(delegated("helper", "c", { creationSource: "provider" }), "c"));
  NodeAssert.ok(!isWorker(delegated("nested", "task"), "c"));
  NodeAssert.ok(!isWorker(thread("c"), "c"));
  NodeAssert.ok(
    !isWorker(
      thread("fork", { lineage: { parentThreadId: "c", relationshipToParent: "fork" } }),
      "c",
    ),
  );
  NodeAssert.ok(!isWorker(thread("unrelated"), "c"));
});

NodeTest.test("attention outranks running, and a person's unsettle beats an old settle", () => {
  NodeAssert.equal(workerState(thread("a", { isRunning: true, needsAttention: true })), "waiting");
  NodeAssert.equal(workerState(thread("a", { isRunning: true })), "working");
  NodeAssert.equal(workerState(thread("a", { settledAt: "2026-10-01" })), "done");
  NodeAssert.equal(workerState(thread("a", { settledOverride: "settled" })), "done");
  NodeAssert.equal(
    workerState(thread("a", { settledAt: "2026-10-01", settledOverride: "active" })),
    "ready",
  );
  NodeAssert.equal(workerState(thread("a")), "ready");
});

NodeTest.test("groups skip archived workers and keep creation order as activity changes", () => {
  const groups = groupWorkers(
    [
      delegated("second", "c", { createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-01" }),
      delegated("first", "c", { createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-24" }),
      delegated("gone", "c", { archivedAt: "2026-10-02" }),
    ],
    "c",
  );
  NodeAssert.deepEqual(
    groups.ready.map((t) => t.id),
    ["first", "second"],
  );
});

NodeTest.test("the coordinator's status leads with what is waiting on the person", () => {
  const many = (state, n) => Array.from({ length: n }, (_, i) => ({ id: `${state}${i}` }));
  const idle = { waiting: [], working: [], ready: [], done: [] };
  NodeAssert.deepEqual(
    coordinatorStatus({ ...idle, waiting: many("n", 1), working: many("w", 2) }),
    { label: "1 waiting on you", tone: "warning" },
  );
  const busy = coordinatorStatus({ ...idle, working: many("w", 12), ready: many("r", 12) });
  NodeAssert.deepEqual(busy, { label: "12 working · 12 ready for review", tone: "info" });
  NodeAssert.ok(busy.label.length <= 40);
  NodeAssert.equal(coordinatorStatus({ ...idle, ready: many("r", 2) }).tone, "success");
  NodeAssert.deepEqual(coordinatorStatus(idle), { label: "No threads yet", tone: "neutral" });
  NodeAssert.equal(coordinatorStatus({ ...idle, done: [{}] }).label, "All threads done");
  NodeAssert.deepEqual(coordinatorStatus({ ...idle, done: [{}] }, { needsAttention: true }), {
    label: "Waiting on you",
    tone: "warning",
  });
});

NodeTest.test("the overview lists only groups with threads, in the order a person acts on", () => {
  const view = overview(
    [
      thread("c"),
      delegated("done", "c", { settledAt: "2026-10-01" }),
      delegated("run", "c", { isRunning: true }),
      delegated("ask", "c", { needsAttention: true }),
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
  NodeAssert.equal(view.status.label, "1 waiting on you");
});

NodeTest.test("memory refuses to grow past its budget instead of dropping old decisions", () => {
  let memory = { version: 1, notes: [] };
  for (let i = 0; i < MEMORY_LIMITS.notes; i++)
    memory = appendNote(memory, { id: `n${i}`, text: "x", threadId: "t", createdAt: "" });
  NodeAssert.equal(appendNote(memory, { id: "n0", text: "x" }), memory);
  NodeAssert.throws(() => appendNote(memory, { id: "n0", text: "else" }), /different note/);
  NodeAssert.throws(() => appendNote(memory, { id: "extra", text: "x" }), /memory is full/);
});

NodeTest.test("stored data from an unknown version is refused, not overwritten", () => {
  NodeAssert.deepEqual(decodeCoordinators(null), { version: 1, projects: {} });
  NodeAssert.throws(() => decodeCoordinators({ version: 2, projects: {} }), /unknown format/);
});

NodeTest.test("the first message stays short and hands off to the guide", () => {
  NodeAssert.ok(BRIEF.length <= 120, `${BRIEF.length} characters`);
  NodeAssert.match(BRIEF, /guide action/);
  for (const tool of ["delegate_task", "memory-read", "memory-append", "t3_thread_organize"])
    NodeAssert.ok(GUIDE.includes(tool), tool);
  NodeAssert.match(GUIDE, /ask what this project should accomplish/);
});
