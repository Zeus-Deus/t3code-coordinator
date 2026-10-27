// Project Coordinator: one coordinator thread per project, a Projects tree with its workers nested
// under it, and shared project memory. Delegation stays in T3's orchestration tools; this plugin
// never starts workers.
import {
  appendNote,
  BRIEF,
  buildTree,
  decodeCoordinators,
  decodeMemory,
  GUIDE,
  hashId,
  isWorker,
  memoryKey,
  noteText,
  overview,
  projectSection,
} from "./lib/coordinator.mjs";

const COORDINATORS = "coordinators.v1";
const PAGE = 200;
// Every page loads the whole project on the host, and statuses and views are read often.
const SCAN_PAGES = 10;
// Host calls one tree read may spend across every project; the rest stay in Other.
const TREE_BUDGET = 80;
const TREE = "projects";
const VIEW = "overview";
const TOPICS = [`tree:${TREE}`, `view:${VIEW}`, `status:${VIEW}`];

export function activate(ctx) {
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  const readCoordinators = async () =>
    decodeCoordinators(await ctx.storage.get(COORDINATORS));
  const readMemory = async (projectId) =>
    decodeMemory(await ctx.storage.get(memoryKey(projectId)));

  const listThreads = async (projectId, invocation, budget) => {
    const threads = new Map();
    let cursor = 0;
    while (budget.calls-- > 0) {
      invocation.signal.throwIfAborted();
      const page = await ctx.threads.list({ projectId, cursor, limit: PAGE });
      for (const thread of page.threads) threads.set(thread.id, thread);
      if (page.nextCursor === null)
        return { threads: [...threads.values()], complete: true };
      if (!(page.nextCursor > cursor)) break;
      cursor = page.nextCursor;
    }
    return { threads: [...threads.values()], complete: false };
  };

  const listProjects = async (invocation, budget) => {
    const projects = new Map();
    let cursor = 0;
    while (budget.calls-- > 0) {
      invocation.signal.throwIfAborted();
      const page = await ctx.projects.list({ cursor, limit: PAGE });
      for (const project of page.projects) projects.set(project.id, project);
      if (page.nextCursor === null || !(page.nextCursor > cursor)) break;
      cursor = page.nextCursor;
    }
    return projects;
  };

  /** The open thread, as the host reports it. */
  const contextThread = async (invocation) => {
    const threadId = invocation.context?.threadId;
    if (!threadId) throw new Error("Open a thread in the project first.");
    return ctx.threads.metadata({ threadId });
  };

  /** Memory belongs to the verified caller's project, never to a target the agent names. */
  const agentThread = async (invocation) => {
    const { caller } = invocation;
    if (caller.kind !== "agent" || !caller.threadId)
      throw new Error(
        "Project memory is available to agents running in a T3 thread.",
      );
    return ctx.threads.metadata({ threadId: caller.threadId });
  };

  const liveCoordinator = async (projectId) => {
    const stored = (await readCoordinators()).projects[projectId];
    if (!stored) return null;
    try {
      const thread = await ctx.threads.metadata({ threadId: stored.threadId });
      return thread.projectId === projectId && !thread.archivedAt
        ? thread
        : null;
    } catch (error) {
      // Threads in a granted project are readable, so a denial means the coordinator was deleted.
      // Without the grant, starting a replacement is denied as well.
      if (error?.reason === "permission_denied") return null;
      throw error;
    }
  };

  const invalidate = async (topics) => {
    try {
      await ctx.ui.invalidate(topics);
    } catch {
      ctx.log(
        "warn",
        "Could not notify open views; they refresh on their next read.",
      );
    }
  };

  const openCoordinator = (projectId, invocation) =>
    serial(async () => {
      const existing = await liveCoordinator(projectId);
      if (existing) return { threadId: existing.id, created: false };
      const { threadId } = await ctx.threads.create({
        projectId,
        // The breadcrumb already names the project: "Shelf / Coordinator".
        title: "Coordinator",
        text: BRIEF,
        // A plan-mode source thread would otherwise make the coordinator and its workers plan-only.
        interactionMode: "default",
        idempotencyKey: "start-coordinator",
      });
      const store = await readCoordinators();
      store.projects[projectId] = {
        threadId,
        createdAt: new Date().toISOString(),
      };
      await ctx.storage.set(COORDINATORS, store);
      await invalidate(TOPICS);
      return { threadId, created: true };
    });

  const addNote = (projectId, note) =>
    serial(async () => {
      const memory = appendNote(await readMemory(projectId), note);
      try {
        await ctx.storage.set(memoryKey(projectId), memory);
      } catch (error) {
        throw new Error(
          `Project memory could not be saved (${error?.message ?? "storage failed"}). ` +
            "Remove notes in the Overview and retry.",
        );
      }
      await invalidate([`view:${VIEW}`]);
      return memory;
    });

  const coordinatorAction = async (_input, invocation) => {
    // A project in context wins: the sidebar names the project its row belongs to, while the
    // open thread may be in another one. The palette falls back to the open thread's project.
    const context = invocation.context ?? {};
    const projectId =
      context.projectId ??
      (context.threadId ? (await contextThread(invocation)).projectId : null);
    if (!projectId) return { message: "Select a project first." };
    const { threadId, created } = await openCoordinator(projectId, invocation);
    // Like a new project in Claude Code Projects, the Overview is open the first time only.
    return {
      intents: [
        created
          ? { type: "view.open", viewId: VIEW, threadId }
          : { type: "thread.reveal", threadId },
      ],
    };
  };
  ctx.handle("action:coordinator", coordinatorAction);
  // The Projects tab's row for a project that has no coordinator yet.
  ctx.handle("action:start-coordinator", coordinatorAction);

  ctx.handle("action:guide", () => ({ message: GUIDE }));

  ctx.handle("action:memory-read", async (_input, invocation) => {
    const { projectId } = await agentThread(invocation);
    const { notes } = await readMemory(projectId);
    return {
      message: notes.length
        ? `${notes.length} notes in project memory, oldest first.`
        : "Project memory is empty.",
      data: { notes },
    };
  });

  ctx.handle("action:memory-append", async (input, invocation) => {
    const text = noteText(input?.text);
    const thread = await agentThread(invocation);
    // Agents reuse the operation id when retrying, so the same call never adds a second note.
    const id = hashId(thread.id, invocation.operationId).slice(0, 16);
    const { notes } = await addNote(thread.projectId, {
      id,
      text,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    return {
      message: "Added to project memory.",
      data: { id, count: notes.length },
    };
  });

  ctx.handle(`view:${VIEW}:read`, async (_input, invocation) => {
    const thread = await contextThread(invocation);
    const coordinator = await liveCoordinator(thread.projectId);
    const [{ notes }, projects] = await Promise.all([
      readMemory(thread.projectId),
      listProjects(invocation, { calls: 2 }),
    ]);
    const scan = coordinator
      ? await listThreads(thread.projectId, invocation, { calls: SCAN_PAGES })
      : null;
    return {
      data: {
        project: projects.get(thread.projectId)?.title ?? null,
        coordinator: coordinator && { threadId: coordinator.id },
        current: thread.id,
        // A partial scan could hide running work, so the panel says so instead of guessing.
        overview: scan?.complete
          ? overview(scan.threads, coordinator.id)
          : null,
        notes,
      },
    };
  });

  ctx.handle(`view:${VIEW}:remember`, async (input, invocation) => {
    const thread = await contextThread(invocation);
    const { notes } = await addNote(thread.projectId, {
      id: hashId("person", invocation.operationId).slice(0, 16),
      text: noteText(input?.text),
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    return { data: { notes } };
  });

  ctx.handle(`view:${VIEW}:forget`, async (input, invocation) => {
    const thread = await contextThread(invocation);
    const notes = await serial(async () => {
      const memory = await readMemory(thread.projectId);
      const next = {
        ...memory,
        notes: memory.notes.filter((note) => note.id !== input?.id),
      };
      await ctx.storage.set(memoryKey(thread.projectId), next);
      return next.notes;
    });
    await invalidate([`view:${VIEW}`]);
    return { data: { notes } };
  });

  // Like Claude Code Projects' Overview button, the chip is the same on the coordinator and on
  // every thread it started, so the Overview is one click away wherever the person is.
  ctx.handle(`status:${VIEW}`, async (_input, invocation) => {
    const thread = await contextThread(invocation);
    const coordinatorId = (await readCoordinators()).projects[thread.projectId]
      ?.threadId;
    if (!coordinatorId || thread.archivedAt) return { data: null };
    if (thread.id !== coordinatorId && !isWorker(thread, coordinatorId))
      return { data: null };
    const scan = await listThreads(thread.projectId, invocation, {
      calls: SCAN_PAGES,
    });
    const coordinator = scan.threads.find((t) => t.id === coordinatorId);
    // Pages follow thread ids, not activity, so a partial count could hide running work.
    if (!scan.complete || !coordinator || coordinator.archivedAt)
      return { data: null };
    return { data: overview(scan.threads, coordinatorId).status };
  });

  ctx.trees.register(TREE, async (invocation) => {
    // One call goes to reading the stored coordinators.
    const budget = { calls: TREE_BUDGET - 1 };
    const [store, projects] = await Promise.all([
      readCoordinators(),
      listProjects(invocation, budget),
    ]);
    const now = Date.now();
    const sections = [];
    // Only ids this call just listed: one stale reference would make the host reject the tree.
    for (const project of [...projects.values()].sort((a, b) =>
      a.title.localeCompare(b.title),
    )) {
      if (budget.calls <= 0) break;
      const { threads, complete } = await listThreads(
        project.id,
        invocation,
        budget,
      );
      sections.push(
        projectSection(
          project.id,
          threads,
          store.projects[project.id]?.threadId,
          now,
        ),
      );
      if (!complete) {
        ctx.log(
          "debug",
          "The Projects tree is bounded; remaining threads stay in Other.",
        );
        break;
      }
    }
    // Hosts without heading actions would reject the field, so it goes only where granted.
    const startAction = ctx.capabilities?.includes("ui.native-tree-actions")
      ? "start-coordinator"
      : undefined;
    return buildTree(sections, { startAction });
  });
}
