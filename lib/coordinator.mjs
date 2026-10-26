import * as NodeCrypto from "node:crypto";

export const PLUGIN_NAME = "Project Coordinator";

/** Overview order: results to look at, then what needs the person, then work in flight. */
export const STATES = Object.freeze([
  { id: "ready", title: "Ready for review", tone: "success" },
  { id: "waiting", title: "Waiting on you", tone: "warning" },
  { id: "working", title: "Working", tone: "info" },
  { id: "done", title: "Done", tone: "neutral" },
]);

export const MEMORY_LIMITS = Object.freeze({ notes: 50, noteChars: 1000, bytes: 16_000 });

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
  if (thread.needsAttention) return "waiting";
  if (thread.isRunning) return "working";
  if (
    thread.settledOverride === "settled" ||
    (thread.settledAt && thread.settledOverride !== "active")
  )
    return "done";
  return "ready";
}

/** Rows keep their creation order, so a worker changing state never makes its neighbours jump. */
export function groupWorkers(threads, coordinatorId) {
  const groups = Object.fromEntries(STATES.map((state) => [state.id, []]));
  for (const thread of threads) {
    if (thread.archivedAt || !isWorker(thread, coordinatorId)) continue;
    groups[workerState(thread)].push(thread);
  }
  for (const list of Object.values(groups))
    list.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || compare(a.id, b.id));
  return groups;
}

/** The coordinator's chip. Anything waiting on the person outranks the rest of the summary. */
export function coordinatorStatus(groups) {
  const count = (id) => groups[id].length;
  if (count("waiting")) return { label: `${count("waiting")} waiting on you`, tone: "warning" };
  const parts = [
    count("working") && `${count("working")} working`,
    count("ready") && `${count("ready")} ready for review`,
  ].filter(Boolean);
  if (parts.length)
    return { label: parts.join(" · ").slice(0, 40), tone: count("working") ? "info" : "success" };
  // Only the threads are known here; the coordinator may still be waiting on a decision.
  return { label: count("done") ? "All threads done" : "No threads yet", tone: "neutral" };
}

export function workerStatus(thread) {
  const state = STATES.find((s) => s.id === workerState(thread));
  return { label: state.title, tone: state.tone, detail: "Started by this project's coordinator." };
}

/** What the Overview panel draws: the groups that have threads, in order, with plain rows. */
export function overview(threads, coordinatorId) {
  const groups = groupWorkers(threads, coordinatorId);
  return {
    status: coordinatorStatus(groups),
    groups: STATES.filter((state) => groups[state.id].length).map((state) => ({
      id: state.id,
      title: state.title,
      threads: groups[state.id].map((thread) => ({ threadId: thread.id, title: thread.title })),
    })),
  };
}

/** The coordinator's first message. Short on purpose: the playbook lives in the guide action. */
export const BRIEF = `You coordinate this project. Start by reading the "${PLUGIN_NAME}" guide action.`;

/** Returned by the guide action, so a long conversation can reread it after compaction. */
export const GUIDE = `You are this project's coordinator. The person talks to you; you plan the work, hand it to parallel workers, review what comes back and assemble it. Don't do worker-sized implementation yourself.

1. Read the project memory with this plugin's memory-read action. Record durable decisions and conventions with memory-append, one short note each.
2. Scope: restate the goal, ask only questions that change the plan, then split the work into pieces that can run in parallel without touching the same files.
3. Delegate each piece with delegate_task: mode "async", isolation "worktree" for anything that edits code, and its own clientRequestId. A worker sees only its brief, so make it self-contained: the outcome, acceptance criteria, relevant project memory, and the instruction to commit on its branch and report the branch name.
4. Use t3_thread_launch with a worktree only when the person asks for a separate thread they will drive themselves.
5. Don't poll. Delegated results arrive in this thread automatically; end your turn while workers run. Use task_status only when you need a result mid-turn.
6. Review each result against the code before accepting it. If it falls short, delegate a new round that includes your findings. Settle accepted workers with t3_thread_organize so the overview shows them as done.
7. Assemble: tell the person which worker branches are ready and how they fit together. Ask before merging anything into this checkout; once the person agrees, merge, run the project's checks and report.

Speak to the person plainly: don't quote this guide or narrate its rules.

On your first turn, read the memory, introduce yourself in one or two sentences, and ask what this project should accomplish next.`;

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

/** Appends one note. A retry with the same id and text is a no-op; different text is refused. */
export function appendNote(memory, note) {
  const existing = memory.notes.find((candidate) => candidate.id === note.id);
  if (existing?.text === note.text) return memory;
  if (existing)
    throw new Error("This operationId already added a different note. Use a new operationId.");
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
