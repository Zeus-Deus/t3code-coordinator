import * as NodeCrypto from "node:crypto";

export const PLUGIN_NAME = "Project Coordinator";

export const STATES = Object.freeze([
  { id: "needs-you", title: "Needs you", tone: "warning" },
  { id: "working", title: "Working", tone: "info" },
  { id: "ready", title: "Ready for review", tone: "success" },
  { id: "done", title: "Done", tone: "neutral" },
]);

export const MEMORY_LIMITS = Object.freeze({ notes: 50, noteChars: 1000, bytes: 16_000 });
// Headroom below the host's 2000 nodes / 128000 bytes per snapshot.
export const TREE_LIMITS = Object.freeze({ nodes: 1800, bytes: 120_000 });

const timestamp = (value) => Date.parse(value ?? "") || 0;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Node ids and storage keys allow only `[a-zA-Z0-9._-]`; thread and project ids may not fit. */
export const hashId = (...parts) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export const memoryKey = (projectId) => `memory.v1.${hashId(projectId)}`;

/**
 * A direct worker: an app-owned `delegate_task` child of the coordinator, or a thread it started
 * with `t3_thread_launch` / `create_threads`. A worker's own delegations are its business.
 */
export function isWorker(thread, coordinatorId) {
  if (thread.id === coordinatorId) return false;
  const { lineage } = thread;
  if (lineage?.relationshipToParent === "subagent")
    return lineage.parentThreadId === coordinatorId && thread.creationSource !== "provider";
  return thread.launchedFrom?.threadId === coordinatorId;
}

/** Done means settled, by the coordinator after review or by T3 (merged PR, inactivity). */
export function workerState(thread) {
  if (thread.needsAttention) return "needs-you";
  if (thread.isRunning) return "working";
  if (
    thread.settledOverride === "settled" ||
    (thread.settledAt && thread.settledOverride !== "active")
  )
    return "done";
  return "ready";
}

export function groupWorkers(threads, coordinatorId) {
  const groups = Object.fromEntries(STATES.map((state) => [state.id, []]));
  for (const thread of threads) {
    if (thread.archivedAt || !isWorker(thread, coordinatorId)) continue;
    groups[workerState(thread)].push(thread);
  }
  for (const list of Object.values(groups))
    list.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || compare(a.id, b.id));
  return groups;
}

export function coordinatorStatus(groups) {
  const counts = [
    ["needs-you", "needs you"],
    ["working", "working"],
    ["ready", "to review"],
  ]
    .filter(([id]) => groups[id].length > 0)
    .map(([id, label]) => `${groups[id].length} ${label}`);
  const tone = groups["needs-you"].length
    ? "warning"
    : groups.working.length
      ? "info"
      : groups.ready.length
        ? "success"
        : "neutral";
  const idle = groups.done.length ? "All done" : "No workers yet";
  return { label: (counts.join(" · ") || idle).slice(0, 40), tone };
}

export function workerStatus(thread) {
  const state = STATES.find((s) => s.id === workerState(thread));
  return { label: state.title, tone: state.tone, detail: "Works for this project's coordinator." };
}

/**
 * One section per project with a live coordinator: the coordinator row, then state groups as its
 * siblings. Headings cannot nest under a thread row, and a worker's own children follow it there.
 */
export function buildTree(sections) {
  const nodes = [];
  let bytes = Buffer.byteLength(JSON.stringify({ nodes }));
  const fits = (batch) => {
    const extra = batch.reduce((sum, n) => sum + Buffer.byteLength(JSON.stringify(n)) + 1, 0);
    if (nodes.length + batch.length > TREE_LIMITS.nodes || bytes + extra > TREE_LIMITS.bytes)
      return false;
    nodes.push(...batch);
    bytes += extra;
    return true;
  };
  for (const { projectId, coordinator, threads } of sections) {
    const heading = { id: `p-${hashId(projectId)}`, kind: "project", projectId };
    const row = {
      id: `c-${hashId(coordinator.id)}`,
      parentId: heading.id,
      kind: "thread",
      threadId: coordinator.id,
    };
    if (!fits([heading, row])) break;
    const groups = groupWorkers(threads, coordinator.id);
    for (const state of STATES) {
      const workers = groups[state.id];
      if (!workers.length) continue;
      const group = {
        id: `g-${hashId(projectId, state.id)}`,
        parentId: heading.id,
        kind: "group",
        title: state.title,
        ...(state.id === "done" ? { collapsedByDefault: true } : {}),
      };
      if (!fits([group])) return { nodes };
      for (const worker of workers) {
        const node = {
          id: `w-${hashId(worker.id)}`,
          parentId: group.id,
          kind: "thread",
          threadId: worker.id,
        };
        // Omitted workers stay reachable through the host's unplaced rows.
        if (!fits([node])) return { nodes };
      }
    }
  }
  return { nodes };
}

export function brief() {
  return `You are this project's coordinator. The person talks to you; you plan the work, hand it to parallel workers, review what comes back and assemble it. Don't do worker-sized implementation yourself.

How to work:
1. Read the project memory first: call t3_plugin_list, find "${PLUGIN_NAME}", and invoke its memory-read action with t3_plugin_invoke. Record durable decisions and conventions with memory-append, one short note each.
2. Scope: restate the goal, ask only questions that change the plan, then split the work into pieces that can run in parallel without touching the same files.
3. Delegate each piece with delegate_task: mode "async", isolation "worktree" for anything that edits code, and its own clientRequestId. A worker sees only its brief, so make it self-contained: the outcome, acceptance criteria, relevant project memory, and the instruction to commit on its branch and report the branch name.
4. Use t3_thread_launch with a worktree only when the person asks for a separate thread they will drive themselves.
5. Don't poll. Delegated results arrive in this thread automatically; end your turn while workers run. Use task_status only when you need a result mid-turn.
6. Review each result against the code before accepting it. If it falls short, delegate a new round that includes your findings. Settle accepted workers with t3_thread_organize so the overview shows them as done.
7. Assemble: tell the person which worker branches are ready and how they fit together. Merge them into this checkout only when the person agrees, then run the project's checks and report.

Now read the project memory, introduce yourself in one or two sentences, and ask what this project should accomplish next.`;
}

export function decodeCoordinators(value) {
  if (value === null) return { version: 1, projects: {} };
  if (!record(value) || value.version !== 1 || !record(value.projects))
    throw new Error("Stored coordinators use an unknown format. Update the plugin to read them.");
  return value;
}

export function decodeMemory(value) {
  if (value === null) return { version: 1, notes: [] };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.notes))
    throw new Error("Stored project memory uses an unknown format. Update the plugin to read it.");
  return value;
}

/** Appends one note, or returns the memory unchanged when this note id is already present. */
export function appendNote(memory, note) {
  if (memory.notes.some((existing) => existing.id === note.id)) return memory;
  const next = { ...memory, notes: [...memory.notes, note] };
  if (
    next.notes.length > MEMORY_LIMITS.notes ||
    Buffer.byteLength(JSON.stringify(next)) > MEMORY_LIMITS.bytes
  )
    throw new Error(
      "Project memory is full. Ask the person to remove notes in the Coordinator panel, then retry.",
    );
  return next;
}

export function noteText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("A note needs text.");
  if (text.length > MEMORY_LIMITS.noteChars)
    throw new Error(`Keep a note under ${MEMORY_LIMITS.noteChars} characters.`);
  return text;
}
