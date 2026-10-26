// Project Coordinator: one coordinator thread per project, an overview of its workers, and shared
// project memory. Delegation stays in T3's orchestration tools; this plugin never starts workers.
import {
  appendNote,
  BRIEF,
  decodeCoordinators,
  decodeMemory,
  GUIDE,
  hashId,
  isWorker,
  memoryKey,
  noteText,
  overview,
  workerStatus,
} from "./lib/coordinator.mjs";

const COORDINATORS = "coordinators.v1";
const PAGE = 200;
// Every page loads the whole project on the host, and statuses and views are read often.
const SCAN_PAGES = 10;
const VIEW = "overview";
const TOPICS = [`view:${VIEW}`, `status:${VIEW}`];

export function activate(ctx) {
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  const readCoordinators = async () => decodeCoordinators(await ctx.storage.get(COORDINATORS));
  const readMemory = async (projectId) => decodeMemory(await ctx.storage.get(memoryKey(projectId)));

  const listThreads = async (projectId, invocation, budget) => {
    const threads = new Map();
    let cursor = 0;
    while (budget.calls-- > 0) {
      invocation.signal.throwIfAborted();
      const page = await ctx.threads.list({ projectId, cursor, limit: PAGE });
      for (const thread of page.threads) threads.set(thread.id, thread);
      if (page.nextCursor === null) return { threads: [...threads.values()], complete: true };
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
      throw new Error("Project memory is available to agents running in a T3 thread.");
    return ctx.threads.metadata({ threadId: caller.threadId });
  };

  const liveCoordinator = async (projectId) => {
    const stored = (await readCoordinators()).projects[projectId];
    if (!stored) return null;
    try {
      const thread = await ctx.threads.metadata({ threadId: stored.threadId });
      return thread.projectId === projectId && !thread.archivedAt ? thread : null;
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
      ctx.log("warn", "Could not notify open views; they refresh on their next read.");
    }
  };

  const openCoordinator = (projectId, invocation) =>
    serial(async () => {
      const existing = await liveCoordinator(projectId);
      if (existing) return existing.id;
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
      store.projects[projectId] = { threadId, createdAt: new Date().toISOString() };
      await ctx.storage.set(COORDINATORS, store);
      await invalidate(TOPICS);
      return threadId;
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

  ctx.handle("action:coordinator", async (_input, invocation) => {
    const { threadId, projectId: selected } = invocation.context ?? {};
    // From the palette a person may have a project selected without any thread open in it.
    const projectId = threadId ? (await contextThread(invocation)).projectId : selected;
    if (!projectId) return { message: "Select a project first." };
    const coordinatorId = await openCoordinator(projectId, invocation);
    // Reveals the coordinator with its Overview beside it, as one step.
    return { intents: [{ type: "view.open", viewId: VIEW, threadId: coordinatorId }] };
  });

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
    return { message: "Added to project memory.", data: { id, count: notes.length } };
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
        coordinator: coordinator && { threadId: coordinator.id, title: coordinator.title },
        isCoordinator: coordinator?.id === thread.id,
        current: thread.id,
        // A partial scan could hide running work, so the panel says so instead of guessing.
        overview: scan?.complete ? overview(scan.threads, coordinator.id) : null,
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
      const next = { ...memory, notes: memory.notes.filter((note) => note.id !== input?.id) };
      await ctx.storage.set(memoryKey(thread.projectId), next);
      return next.notes;
    });
    await invalidate([`view:${VIEW}`]);
    return { data: { notes } };
  });

  ctx.handle(`status:${VIEW}`, async (_input, invocation) => {
    const thread = await contextThread(invocation);
    const coordinatorId = (await readCoordinators()).projects[thread.projectId]?.threadId;
    if (!coordinatorId || thread.archivedAt) return { data: null };
    if (thread.id === coordinatorId) {
      const scan = await listThreads(thread.projectId, invocation, { calls: SCAN_PAGES });
      // Pages follow thread ids, not activity, so a partial count could hide running work.
      if (!scan.complete) return { data: null };
      return { data: overview(scan.threads, coordinatorId).status };
    }
    if (!isWorker(thread, coordinatorId)) return { data: null };
    return { data: (await liveCoordinator(thread.projectId)) ? workerStatus(thread) : null };
  });
}
