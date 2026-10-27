import * as NodeCrypto from "node:crypto";

/** The Overview's groups, in Claude Code Projects' order: results first, then what needs you. */
export const STATES = Object.freeze([
  { id: "ready", title: "Ready for review" },
  { id: "waiting", title: "Waiting on you" },
  { id: "working", title: "Working" },
  { id: "done", title: "Done" },
]);

/** The host's tree bounds, with headroom; past them the remaining threads stay in Other. */
export const TREE_LIMITS = Object.freeze({
  nodes: 1800,
  bytes: 120_000,
  inlineDone: 5,
});

export const MEMORY_LIMITS = Object.freeze({
  notes: 50,
  noteChars: 1000,
  bytes: 16_000,
});

const timestamp = (value) => Date.parse(value ?? "") || 0;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Node ids and storage keys allow only `[a-zA-Z0-9._-]`; thread and project ids may not fit. */
export const hashId = (...parts) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);

export const memoryKey = (projectId) => `memory.v1.${hashId(projectId)}`;

/**
 * A direct worker: an app-owned `delegate_task` child of the coordinator, or a thread it started
 * with `t3_thread_launch` / `create_threads`. A worker's own delegations are its business.
 */
export function isWorker(thread, coordinatorId) {
  if (thread.id === coordinatorId) return false;
  const { lineage } = thread;
  if (lineage?.relationshipToParent === "subagent")
    return (
      lineage.parentThreadId === coordinatorId &&
      thread.creationSource !== "provider"
    );
  return thread.launchedFrom?.threadId === coordinatorId;
}

/** Settled by the coordinator after review or by T3 (merged PR, inactivity); a person's unsettle wins. */
export const isSettled = (thread) =>
  thread.settledOverride === "settled" ||
  (Boolean(thread.settledAt) && thread.settledOverride !== "active");

export function workerState(thread) {
  if (thread.needsAttention) return "waiting";
  if (thread.isRunning) return "working";
  return isSettled(thread) ? "done" : "ready";
}

const byCreation = (a, b) =>
  timestamp(a.createdAt) - timestamp(b.createdAt) || compare(a.id, b.id);

/** Rows keep their creation order, so a worker changing state never makes its neighbours jump. */
export function groupWorkers(threads, coordinatorId) {
  const groups = Object.fromEntries(STATES.map((state) => [state.id, []]));
  for (const thread of threads) {
    if (thread.archivedAt || !isWorker(thread, coordinatorId)) continue;
    groups[workerState(thread)].push(thread);
  }
  for (const list of Object.values(groups)) list.sort(byCreation);
  return groups;
}

/** The coordinator's chip. Anything waiting on the person outranks the rest of the summary. */
export function coordinatorStatus(groups, coordinator) {
  const count = (id) => groups[id].length;
  // A question or approval in the coordinator counts too; a plain-text question raises no signal.
  const waiting = count("waiting") + (coordinator?.needsAttention ? 1 : 0);
  if (waiting) return { label: `${waiting} waiting on you`, tone: "warning" };
  const parts = [
    count("working") && `${count("working")} working`,
    count("ready") && `${count("ready")} ready for review`,
  ].filter(Boolean);
  if (parts.length)
    return {
      label: parts.join(" · ").slice(0, 40),
      tone: count("working") ? "info" : "success",
    };
  // Only the workers are known here; the coordinator may still be waiting on a decision.
  return {
    label: count("done") ? "All workers done" : "No workers yet",
    tone: "neutral",
  };
}

/** What the Overview shows: the summary and the groups that have threads, in order. */
export function overview(threads, coordinatorId) {
  const groups = groupWorkers(threads, coordinatorId);
  const coordinator = threads.find((thread) => thread.id === coordinatorId);
  return {
    status: coordinatorStatus(groups, coordinator),
    groups: STATES.filter((state) => groups[state.id].length).map((state) => ({
      id: state.id,
      title: state.title,
      threads: groups[state.id].map((thread) => ({
        threadId: thread.id,
        title: thread.title,
      })),
    })),
  };
}

/**
 * One project's place in the sidebar tree: its coordinator, the workers it started in the order it
 * started them, then the project's other live threads by recent activity. Finished workers stay in
 * place until there are enough of them to bury the rest; the oldest then fold into Done.
 */
export function projectSection(
  projectId,
  threads,
  coordinatorId,
  now = Date.now(),
) {
  const listed = threads.filter((thread) => !thread.archivedAt);
  const coordinator =
    listed.find((thread) => thread.id === coordinatorId) ?? null;
  const workers = coordinator
    ? listed
        .filter((thread) => isWorker(thread, coordinator.id))
        .sort(byCreation)
    : [];
  // Done as the status counts it: a settled worker still waiting on the person stays in view.
  const done = workers.filter((thread) => workerState(thread) === "done");
  const folded = new Set(
    done
      .slice(0, Math.max(0, done.length - TREE_LIMITS.inlineDone))
      .map((t) => t.id),
  );
  const placed = new Set([
    coordinator?.id,
    ...workers.map((thread) => thread.id),
  ]);
  // Forks and sub-threads follow their parent row on their own, parked ones included. Parked
  // top-level threads stay on T3's Settled and Snoozed shelves, as they do in Activity.
  const others = listed
    .filter(
      (thread) =>
        !placed.has(thread.id) &&
        !thread.lineage?.parentThreadId &&
        !isSettled(thread) &&
        !(timestamp(thread.snoozedUntil) > now),
    )
    .sort(
      (a, b) =>
        timestamp(b.updatedAt) - timestamp(a.updatedAt) || compare(a.id, b.id),
    );
  return {
    projectId,
    coordinator,
    workers: workers.filter((thread) => !folded.has(thread.id)),
    done: workers.filter((thread) => folded.has(thread.id)),
    others,
  };
}

/**
 * The "Projects" tree. With `openAction` the project heading is the coordinator conversation
 * itself: it names the coordinator's thread, or the action that starts it, and the workers hang
 * directly off it. Without it (older hosts) the coordinator is a row under the heading.
 */
export function buildTree(sections, { openAction } = {}) {
  const nodes = [];
  let bytes = Buffer.byteLength(JSON.stringify({ nodes }));
  const fits = (batch) => {
    const extra = batch.reduce(
      (sum, n) => sum + Buffer.byteLength(JSON.stringify(n)) + 1,
      0,
    );
    if (
      nodes.length + batch.length > TREE_LIMITS.nodes ||
      bytes + extra > TREE_LIMITS.bytes
    )
      return false;
    nodes.push(...batch);
    bytes += extra;
    return true;
  };
  const row = (thread, parentId, prefix = "t") => ({
    id: `${prefix}-${hashId(thread.id)}`,
    parentId,
    kind: "thread",
    threadId: thread.id,
  });
  for (const section of sections) {
    const heading = {
      id: `p-${hashId(section.projectId)}`,
      kind: "project",
      projectId: section.projectId,
      ...(openAction
        ? section.coordinator
          ? { threadId: section.coordinator.id }
          : { actionId: openAction }
        : {}),
    };
    if (!fits([heading])) break;
    if (section.coordinator) {
      const coordinator = openAction
        ? null
        : row(section.coordinator, heading.id, "c");
      const parentId = coordinator?.id ?? heading.id;
      const branch = [
        ...(coordinator ? [coordinator] : []),
        ...section.workers.map((w) => row(w, parentId)),
      ];
      if (section.done.length) {
        // T3 shows a heading placed under a row just below that row.
        const done = {
          id: `d-${hashId(section.projectId)}`,
          parentId,
          kind: "group",
          title: "Done",
          collapsedByDefault: true,
        };
        branch.push(done, ...section.done.map((w) => row(w, done.id)));
      }
      // All or nothing: a coordinator placed without its Done group would pull every omitted
      // worker back under itself. Left out, the branch stays reachable where T3 puts it.
      if (!fits(branch)) break;
    }
    if (!fits(section.others.map((thread) => row(thread, heading.id)))) break;
  }
  return { nodes };
}

/** The coordinator's first message. Short on purpose: the playbook lives in the guide action. */
export const BRIEF =
  "Coordinate this project. Read the coordinator guide before your first reply.";

/** Returned by the guide action, so a long conversation can reread it after compaction. */
export const GUIDE = `You are this project's coordinator. The person talks to you; you plan the work, hand it to parallel workers, review what comes back and assemble it. Don't do worker-sized implementation yourself.

1. Read the project memory with this plugin's memory-read action. Record durable decisions and conventions with memory-append, one short note each.
2. Scope: restate the goal, ask only questions that change the plan, then split the work into pieces that can run in parallel without touching the same files.
3. Delegate each piece with delegate_task: mode "async", isolation "worktree" for anything that edits code, its own clientRequestId, and a title of two or three words, since it names the worker's row in the sidebar. A worker sees only its brief, so make it self-contained: the outcome, acceptance criteria, relevant project memory, and the instruction to commit on its branch and report the branch name.
4. Use t3_thread_launch with a worktree only when the person asks for a separate thread they will drive themselves.
5. Don't poll. Delegated results arrive in this thread automatically; end your turn while workers run. Use task_status only when you need a result mid-turn.
6. Review each result against the code before accepting it. If it falls short, delegate a new round that includes your findings. Settle accepted workers with t3_thread_organize so they show as done.
7. Assemble: tell the person which worker branches are ready and how they fit together. Ask before merging anything into this checkout, simply, for example "These three branches are ready. May I merge them and run the suite?", without explaining why you ask. Once the person agrees, merge, run the project's checks and report.

Speak plainly in your own voice; don't recite these rules or refer to them.

Start from what the person asks for. If they haven't said what the project should accomplish, ask in one sentence.`;

/**
 * Travels with the person's first message on hosts that create the conversation empty. It carries
 * the whole guide, since there is no earlier turn to read it in; the guide action rereads it later.
 */
export const CONVERSATION_BRIEF = `This thread is the project's main conversation in T3 Code, and you are its coordinator. The guide below is from the Project Coordinator plugin; reread it any time with the plugin's guide action, especially after a long conversation is compacted.

${GUIDE}`;

export function decodeCoordinators(value) {
  if (value === null) return { version: 1, projects: {} };
  if (!record(value) || value.version !== 1 || !record(value.projects))
    throw new Error(
      "Stored coordinators use an unknown format. Update the plugin to read them.",
    );
  return value;
}

export function decodeMemory(value) {
  if (value === null) return { version: 1, notes: [] };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.notes))
    throw new Error(
      "Stored project memory uses an unknown format. Update the plugin to read it.",
    );
  return value;
}

/** Appends one note. A retry with the same id and text is a no-op; different text is refused. */
export function appendNote(memory, note) {
  const existing = memory.notes.find((candidate) => candidate.id === note.id);
  if (existing?.text === note.text) return memory;
  if (existing)
    throw new Error(
      "This operationId already added a different note. Use a new operationId.",
    );
  const next = { ...memory, notes: [...memory.notes, note] };
  if (
    next.notes.length > MEMORY_LIMITS.notes ||
    Buffer.byteLength(JSON.stringify(next)) > MEMORY_LIMITS.bytes
  )
    throw new Error(
      "Project memory is full. Ask the person to remove notes in the Project panel, then retry.",
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
