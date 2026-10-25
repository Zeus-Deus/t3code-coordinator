import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  appendNote,
  brief,
  buildTree,
  coordinatorStatus,
  decodeCoordinators,
  groupWorkers,
  isWorker,
  MEMORY_LIMITS,
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
  NodeAssert.equal(
    workerState(thread("a", { isRunning: true, needsAttention: true })),
    "needs-you",
  );
  NodeAssert.equal(workerState(thread("a", { isRunning: true })), "working");
  NodeAssert.equal(workerState(thread("a", { settledAt: "2026-10-01" })), "done");
  NodeAssert.equal(workerState(thread("a", { settledOverride: "settled" })), "done");
  NodeAssert.equal(
    workerState(thread("a", { settledAt: "2026-10-01", settledOverride: "active" })),
    "ready",
  );
  NodeAssert.equal(workerState(thread("a")), "ready");
});

NodeTest.test("groups skip archived workers and list the newest first", () => {
  const groups = groupWorkers(
    [
      delegated("old", "c", { updatedAt: "2026-10-01T00:00:00Z" }),
      delegated("new", "c", { updatedAt: "2026-10-24T00:00:00Z" }),
      delegated("gone", "c", { archivedAt: "2026-10-02" }),
    ],
    "c",
  );
  NodeAssert.deepEqual(
    groups.ready.map((t) => t.id),
    ["new", "old"],
  );
});

NodeTest.test("the coordinator's status counts what needs a look, within 40 characters", () => {
  const many = (state, n) => Array.from({ length: n }, (_, i) => ({ id: `${state}${i}` }));
  const status = coordinatorStatus({
    "needs-you": many("n", 12),
    working: many("w", 12),
    ready: many("r", 12),
    done: [],
  });
  NodeAssert.equal(status.label, "12 needs you · 12 working · 12 to review");
  NodeAssert.ok(status.label.length <= 40);
  NodeAssert.equal(status.tone, "warning");
  const idle = { "needs-you": [], working: [], ready: [], done: [] };
  NodeAssert.deepEqual(coordinatorStatus(idle), { label: "No workers yet", tone: "neutral" });
  NodeAssert.equal(coordinatorStatus({ ...idle, done: [{}] }).label, "All done");
});

NodeTest.test("the tree puts state groups beside the coordinator row, with safe node ids", () => {
  const tree = buildTree([
    {
      projectId: "project:1",
      coordinator: thread("thread:c%3A1"),
      threads: [
        thread("thread:c%3A1"),
        delegated("w1", "thread:c%3A1", { isRunning: true }),
        delegated("w2", "thread:c%3A1", { settledAt: "2026-10-01" }),
      ],
    },
  ]);
  const [project, coordinator, ...rest] = tree.nodes;
  NodeAssert.equal(project.kind, "project");
  NodeAssert.equal(coordinator.threadId, "thread:c%3A1");
  NodeAssert.equal(coordinator.parentId, project.id);
  const groups = rest.filter((n) => n.kind === "group");
  NodeAssert.deepEqual(
    groups.map((g) => [g.title, g.parentId, g.collapsedByDefault ?? false]),
    [
      ["Working", project.id, false],
      ["Done", project.id, true],
    ],
  );
  for (const node of tree.nodes) NodeAssert.match(node.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
});

NodeTest.test("the tree stays inside the host's node and byte limits", () => {
  const threads = [thread("c")];
  for (let i = 0; i < 5000; i++) threads.push(delegated(`${"長".repeat(60)}${i}`));
  const tree = buildTree([{ projectId: "p", coordinator: threads[0], threads }]);
  NodeAssert.ok(tree.nodes.length <= TREE_LIMITS.nodes);
  NodeAssert.ok(Buffer.byteLength(JSON.stringify(tree)) <= TREE_LIMITS.bytes);
  const ids = new Set(tree.nodes.map((n) => n.id));
  for (const node of tree.nodes) NodeAssert.ok(!node.parentId || ids.has(node.parentId));
});

NodeTest.test("memory refuses to grow past its budget instead of dropping old decisions", () => {
  let memory = { version: 1, notes: [] };
  for (let i = 0; i < MEMORY_LIMITS.notes; i++)
    memory = appendNote(memory, { id: `n${i}`, text: "x", threadId: "t", createdAt: "" });
  NodeAssert.equal(appendNote(memory, { id: "n0", text: "again" }), memory);
  NodeAssert.throws(() => appendNote(memory, { id: "extra", text: "x" }), /memory is full/);
});

NodeTest.test("stored data from an unknown version is refused, not overwritten", () => {
  NodeAssert.deepEqual(decodeCoordinators(null), { version: 1, projects: {} });
  NodeAssert.throws(() => decodeCoordinators({ version: 2, projects: {} }), /unknown format/);
});

NodeTest.test("the brief carries the goal and points at T3's own orchestration tools", () => {
  const text = brief("Ship dark mode");
  NodeAssert.match(text, /Ship dark mode/);
  for (const tool of ["delegate_task", "t3_plugin_invoke", "memory-read", "t3_thread_organize"])
    NodeAssert.ok(text.includes(tool), tool);
  NodeAssert.match(brief(""), /ask what this project should accomplish/);
});
