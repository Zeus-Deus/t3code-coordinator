// Project Coordinator: one coordinator thread per project, a Projects tree with its workers nested
// under it, shared project memory, and messages between project coordinators. Delegation stays in
// T3's orchestration tools; this plugin never starts workers.
import {
  appendNote,
  askedRow,
  askMessage,
  BRIEF,
  buildTree,
  CONVERSATION_BRIEF,
  decodeCoordinators,
  decodeHandoffs,
  decodeMemory,
  GUIDE,
  HANDOFF_LIMITS,
  handoffText,
  hashId,
  isProjectConversation,
  isWorker,
  memoryKey,
  messagePreview,
  noteText,
  otherProjects,
  overview,
  overviewSummary,
  projectSection,
  putHandoff,
  repeatedAsk,
  replyMessage,
} from "./lib/coordinator.mjs";

const COORDINATORS = "coordinators.v1";
const HANDOFFS = "handoffs.v1";
const PAGE = 200;
// Every page loads the whole project on the host, and statuses and views are read often.
const SCAN_PAGES = 10;
// Total scan calls across accessible projects, with headroom for context and memory reads.
const READ_BUDGET = 70;
// Host calls one tree read may spend across every project; the rest stay in Other.
const TREE_BUDGET = 80;
const TREE = "projects";
const VIEW = "overview";
const TOPICS = [`tree:${TREE}`, `view:${VIEW}`, `status:${VIEW}`];
// Optional: project headings that are a thread, and threads created empty with a brief.
const CONVERSATIONS = "ui.native-tree-conversations";
// Optional: the Projects tab as its own view, owning its conversations, which leave Activity.
const PROJECTS = "ui.native-tree-projects";
const OWNER = `tree:${TREE}`;
const ASKED = "asked";
const HANDOFF_TOPICS = [...TOPICS, `view:${ASKED}`];
// The hidden action the host runs when a person answers its project card.
const ACCESS_ANSWER = "project-access";
// Opening never guesses: these cases leave the choice to the person.
const PROBLEMS = {
  unknown:
    "Couldn't check this project's conversation, so nothing was started. Try again.",
  ambiguous:
    "This project has more than one conversation. Open the one you want from Settings → Archive.",
  archived:
    "This project's conversation is archived. Restore it from Settings → Archive.",
  noAgent:
    "No agent is ready on this device. Sign in to one in Settings → Providers, then choose this project again.",
  // Only a person's action can restore a thread.
  restore:
    "That project's conversation is archived. A person has to bring it back: New project in the Projects tab, then that project.",
};

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
  const readHandoffs = async () =>
    decodeHandoffs(await ctx.storage.get(HANDOFFS));
  const saveHandoff = async (handoff) =>
    ctx.storage.set(HANDOFFS, putHandoff(await readHandoffs(), handoff));

  const listThreads = async (projectId, invocation, budget) => {
    const threads = new Map();
    let cursor = 0;
    let pages = 0;
    while (budget.calls > 0 && pages++ < SCAN_PAGES) {
      budget.calls--;
      invocation.signal.throwIfAborted();
      let page;
      try {
        page = await ctx.threads.list({ projectId, cursor, limit: PAGE });
      } catch {
        invocation.signal.throwIfAborted();
        break;
      }
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
    let pages = 0;
    while (budget.calls > 0 && pages++ < SCAN_PAGES) {
      budget.calls--;
      invocation.signal.throwIfAborted();
      let page;
      try {
        page = await ctx.projects.list({ cursor, limit: PAGE });
      } catch {
        invocation.signal.throwIfAborted();
        break;
      }
      for (const project of page.projects) projects.set(project.id, project);
      if (page.nextCursor === null) return { projects, complete: true };
      if (!(page.nextCursor > cursor)) break;
      cursor = page.nextCursor;
    }
    return { projects, complete: false };
  };

  /** Only the host's grant-filtered project list is a source of scan targets. */
  const scanAccessible = async (invocation, budget, priority = []) => {
    const listed = await listProjects(invocation, budget);
    const projects = [...listed.projects.values()].sort(
      (a, b) =>
        Number(priority.includes(b.id)) - Number(priority.includes(a.id)) ||
        a.title.localeCompare(b.title),
    );
    const threads = new Map();
    const scanned = new Set();
    let complete = listed.complete;
    for (const project of projects) {
      if (budget.calls <= 0) {
        complete = false;
        break;
      }
      const scan = await listThreads(project.id, invocation, budget);
      scanned.add(project.id);
      complete &&= scan.complete;
      for (const thread of scan.threads) threads.set(thread.id, thread);
    }
    return {
      projects: listed.projects,
      threads: [...threads.values()],
      scanned,
      complete,
    };
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

  const liveCoordinator = async (projectId, store) => {
    const stored = store.projects[projectId];
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

  /** A worker's panel follows its direct launcher, even if its own project has a coordinator. */
  const overviewContext = async (invocation) => {
    const thread = await contextThread(invocation);
    const store = await readCoordinators();
    const launcher = Object.entries(store.projects).find(([, coordinator]) =>
      isWorker(thread, coordinator.threadId),
    );
    const projectId =
      store.projects[thread.projectId]?.threadId === thread.id
        ? thread.projectId
        : (launcher?.[0] ?? thread.projectId);
    const coordinator = await liveCoordinator(projectId, store);
    // Stored ids do not grant access to another project's memory after its grant is revoked.
    return {
      thread,
      projectId: coordinator ? projectId : thread.projectId,
      coordinator,
    };
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

  const conversations = () => ctx.capabilities?.includes(CONVERSATIONS);
  const projectsView = () =>
    conversations() && ctx.capabilities?.includes(PROJECTS);

  /**
   * Where a project's conversation stands. Only a conversation that is provably gone may be
   * replaced: a failed or denied lookup is "unknown", so a second conversation never appears
   * behind the person's back.
   */
  const resolveCoordinator = async (projectId, invocation) => {
    const stored = (await readCoordinators()).projects[projectId];
    if (stored) {
      try {
        const thread = await ctx.threads.metadata({
          threadId: stored.threadId,
        });
        if (thread.projectId !== projectId) return { state: "unknown" };
        return { state: thread.archivedAt ? "archived" : "live", thread };
      } catch (error) {
        if (error?.reason !== "permission_denied") return { state: "unknown" };
      }
    }
    // A denial may be a deleted thread or lost access; listing the project tells them apart, and
    // also finds a conversation created just before its id could be stored.
    let scan;
    try {
      scan = await listThreads(projectId, invocation, { calls: SCAN_PAGES });
    } catch {
      return { state: "unknown" };
    }
    if (!scan.complete) return { state: "unknown" };
    if (stored && scan.threads.some((t) => t.id === stored.threadId))
      return { state: "unknown" };
    const owned = projectsView()
      ? scan.threads.filter(isProjectConversation)
      : [];
    if (owned.length > 1) return { state: "ambiguous" };
    if (owned.length === 1)
      return {
        state: owned[0].archivedAt ? "archived" : "live",
        thread: owned[0],
      };
    return { state: stored ? "deleted" : "none" };
  };

  const remember = async (projectId, threadId) => {
    const store = await readCoordinators();
    if (store.projects[projectId]?.threadId === threadId) return true;
    store.projects[projectId] = {
      threadId,
      createdAt: new Date().toISOString(),
    };
    await ctx.storage.set(COORDINATORS, store);
    return false;
  };

  /** Brings a conversation created before the Projects view owned them into it. Idempotent. */
  const adopt = async (thread) => {
    if (!projectsView() || thread.pluginOwner) return;
    try {
      await ctx.threads.adopt({ threadId: thread.id, owner: OWNER });
    } catch (error) {
      // It stays in Activity until a later open succeeds; nothing becomes unreachable.
      ctx.log(
        "warn",
        `Could not move a conversation into Projects: ${error?.message}`,
      );
    }
  };

  const ensureCoordinator = async (projectId, invocation) => {
    const found = await resolveCoordinator(projectId, invocation);
    if (found.state === "unknown" || found.state === "ambiguous")
      return { problem: found.state };
    if (found.state === "archived" && !projectsView())
      return { problem: "archived" };
    if (found.state === "archived" && invocation.caller.kind !== "client")
      return { problem: "restore" };
    if (found.state === "live" || found.state === "archived") {
      const { thread } = found;
      // Re-adding a project brings back the same conversation, with its history and memory.
      if (found.state === "archived")
        await ctx.threads.unarchive({ threadId: thread.id });
      await adopt(thread);
      const known = await remember(projectId, thread.id);
      if (found.state === "archived" || !known) await invalidate(TOPICS);
      return { threadId: thread.id, created: false };
    }
    // A plan-mode source thread would otherwise make the coordinator and its workers plan-only.
    const common = { projectId, interactionMode: "default" };
    const create = async () =>
      conversations()
        ? // The project heading is this conversation, so it carries the project's name and starts
          // empty: the brief rides along with the person's first message instead of a run now.
          await ctx.threads.create({
            ...common,
            title:
              (await listProjects(invocation, { calls: 2 })).projects.get(
                projectId,
              )?.title ?? "Project",
            brief: CONVERSATION_BRIEF,
            ...(projectsView() ? { owner: OWNER } : {}),
            idempotencyKey: "open-conversation",
          })
        : await ctx.threads.create({
            ...common,
            // The breadcrumb already names the project: "Shelf / Coordinator".
            title: "Coordinator",
            text: BRIEF,
            idempotencyKey: "start-coordinator",
          });
    let threadId;
    try {
      ({ threadId } = await create());
    } catch (error) {
      // A device without a signed-in agent has no model to give a new thread.
      if (error?.reason === "invalid_input" && /model/i.test(error.message))
        return { problem: "noAgent" };
      throw error;
    }
    await remember(projectId, threadId);
    await invalidate(TOPICS);
    return { threadId, created: true };
  };
  const openCoordinator = (projectId, invocation) =>
    serial(() => ensureCoordinator(projectId, invocation));

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

  /**
   * Sends one conversation's unsent messages to a project, oldest first. A failure stops the run
   * and keeps the rest for a retry; it comes back as words for the agent to act on.
   */
  const deliverAsks = async (threadId, projectId, invocation) => {
    const { handoffs } = await readHandoffs();
    for (const handoff of handoffs) {
      if (
        handoff.status !== "pending" ||
        handoff.from.threadId !== threadId ||
        handoff.to.projectId !== projectId
      )
        continue;
      const opened = await ensureCoordinator(projectId, invocation);
      if (opened.problem) return PROBLEMS[opened.problem];
      try {
        await ctx.threads.send({
          threadId: opened.threadId,
          text: askMessage(handoff),
          fromConversation: true,
          idempotencyKey: `ask-${handoff.id}`,
        });
      } catch (error) {
        return error?.message ?? "The message could not be sent.";
      }
      await saveHandoff({
        ...handoff,
        status: "sent",
        text: messagePreview(handoff.text),
        to: { projectId, threadId: opened.threadId },
        sentAt: new Date().toISOString(),
      });
    }
    return null;
  };

  const unsentNote = (problem) =>
    `Your message to that project hasn't gone out: ${problem} It is kept: call ask-project again with the same message once that's sorted.`;

  /** A plain note in a plugin-owned conversation, for what the agent can't see any other way. */
  const nudge = async (threadId, text) => {
    try {
      await ctx.threads.send({
        threadId,
        text,
        idempotencyKey: `note-${hashId(threadId, text)}`,
      });
    } catch (error) {
      ctx.log("warn", `Could not leave a note: ${error?.message}`);
    }
  };

  const coordinatorAction = async (_input, invocation) => {
    // A project in context wins: the sidebar names the project its row belongs to, while the
    // open thread may be in another one. The palette falls back to the open thread's project.
    const context = invocation.context ?? {};
    const projectId =
      context.projectId ??
      (context.threadId ? (await contextThread(invocation)).projectId : null);
    if (!projectId) return { message: "Select a project first." };
    const { threadId, created, problem } = await openCoordinator(
      projectId,
      invocation,
    );
    if (problem) return { message: PROBLEMS[problem] };
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
  // A project heading in the Projects tab whose conversation doesn't exist yet.
  ctx.handle("action:open-conversation", coordinatorAction);
  // "New project" at the top of the Projects tab, after the person picks a project.
  ctx.handle("action:new-project", coordinatorAction);

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

  ctx.handle("action:ask-project", (input, invocation) =>
    serial(async () => {
      const { caller } = invocation;
      const from =
        caller.kind === "agent" && caller.threadId
          ? await ctx.threads.metadata({ threadId: caller.threadId })
          : null;
      const coordinators = await readCoordinators();
      if (!from || coordinators.projects[from.projectId]?.threadId !== from.id)
        throw new Error(
          "Only a project's main conversation can ask another project.",
        );
      const text = handoffText(input?.message);
      const projectId = input?.projectId;
      if (typeof projectId !== "string" || !projectId)
        throw new Error("Name the project with its id from t3_project_list.");
      if (projectId === from.projectId)
        throw new Error("That is this project. Delegate the work instead.");
      // Agents reuse the operation id when retrying, so the same call never sends a second message.
      const id = hashId(from.id, invocation.operationId).slice(0, 16);
      const digest = hashId(text);
      const store = await readHandoffs();
      const repeated = repeatedAsk(store, {
        id,
        digest,
        threadId: from.id,
        projectId,
      });
      if (repeated?.status === "sent")
        return {
          message:
            "That message already went out. Its reply arrives in this conversation; end your turn.",
          data: { handoffId: repeated.id, status: "sent" },
        };
      const { status } = await ctx.projects.requestAccess({
        projectId,
        threadId: from.id,
        actionId: ACCESS_ANSWER,
      });
      if (status === "declined") {
        if (repeated)
          await saveHandoff({ ...repeated, status: "declined", text: "" });
        return {
          message:
            "The person said not now to this project, so nothing was sent. Tell them plainly. You can ask again once they next write here.",
          data: { status },
        };
      }
      if (
        !repeated &&
        store.handoffs.filter((entry) => entry.status === "pending").length >=
          HANDOFF_LIMITS.pending
      )
        throw new Error(
          "Too many messages are waiting to go out. Ask the person to answer the project cards first.",
        );
      const handoff = {
        id,
        digest,
        from: { threadId: from.id, projectId: from.projectId },
        to: { projectId, threadId: null },
        reply: null,
        createdAt: new Date().toISOString(),
        ...repeated,
        status: "pending",
        text,
      };
      await saveHandoff(handoff);
      await invalidate(HANDOFF_TOPICS);
      // The row is the agent's result, so it exists from the first call and follows the handoff.
      const row = async () => {
        if (repeated) return {};
        const { projects } = await listProjects(invocation, { calls: 2 });
        return {
          card: {
            viewId: ASKED,
            summary: `Asked ${projects.get(projectId)?.title ?? "another project"}`,
            data: { handoffId: handoff.id },
          },
        };
      };
      if (status === "pending")
        return {
          message:
            "The person needs to add this project first; T3 shows them a card here. The message is kept and goes out when they approve. Tell them plainly which project you need and why, then end your turn.",
          data: { handoffId: handoff.id, status },
          ...(await row()),
        };
      const problem = await deliverAsks(from.id, projectId, invocation);
      await invalidate(HANDOFF_TOPICS);
      return {
        message: problem
          ? unsentNote(problem)
          : "Sent. The reply arrives in this conversation; end your turn.",
        data: {
          handoffId: handoff.id,
          status: problem ? "pending" : "sent",
        },
        ...(await row()),
      };
    }),
  );

  // The return value goes nowhere, so anything the agent must know travels as a note. The host's
  // record decides what happened: this input is only the signal to look.
  ctx.handle(`action:${ACCESS_ANSWER}`, (_input, invocation) =>
    serial(async () => {
      const { projectId, threadId } = invocation.context ?? {};
      if (!projectId || !threadId) return {};
      const { status } = await ctx.projects.requestAccess({
        projectId,
        threadId,
        actionId: ACCESS_ANSWER,
      });
      const waiting = (await readHandoffs()).handoffs.filter(
        (entry) =>
          entry.status === "pending" && entry.to.projectId === projectId,
      );
      if (status === "declined") {
        for (const handoff of waiting) {
          await saveHandoff({ ...handoff, status: "declined", text: "" });
          await nudge(
            handoff.from.threadId,
            `The person said not now to the project you asked, so this was not sent: "${messagePreview(handoff.text)}". Tell them plainly. You can ask again once they next write here.`,
          );
        }
      }
      if (status === "granted") {
        const problem = await deliverAsks(threadId, projectId, invocation);
        if (problem) await nudge(threadId, unsentNote(problem));
        // One request serves a project, but a message only goes out in its own sender's name.
        const others = new Set(waiting.map((entry) => entry.from.threadId));
        others.delete(threadId);
        for (const other of others)
          await nudge(
            other,
            "The project you asked was added. Call ask-project again with the same message to send it.",
          );
      }
      await invalidate(HANDOFF_TOPICS);
      return {};
    }),
  );

  ctx.handle("action:reply-project", (input, invocation) =>
    serial(async () => {
      const { caller } = invocation;
      if (caller.kind !== "agent" || !caller.threadId)
        throw new Error("Replies come from a project's main conversation.");
      const text = handoffText(input?.message);
      // Only a stored handoff addressed to this conversation says where a reply may go.
      const handoff = (await readHandoffs()).handoffs.find(
        (entry) =>
          entry.id === input?.handoffId &&
          entry.status === "sent" &&
          entry.to.threadId === caller.threadId,
      );
      if (!handoff)
        throw new Error(
          "This conversation has no ask with that handoffId to reply to.",
        );
      const id = hashId(caller.threadId, invocation.operationId).slice(0, 16);
      const digest = hashId(text);
      if (handoff.reply?.id === id && handoff.reply.digest === digest)
        return { message: "That reply already went out." };
      if (handoff.reply?.id === id)
        throw new Error(
          "This operationId already sent a different reply. Use a new operationId.",
        );
      if (handoff.reply)
        throw new Error(
          "You already replied to this ask. Each ask gets one reply.",
        );
      await ctx.threads.send({
        threadId: handoff.from.threadId,
        text: replyMessage(text),
        fromConversation: true,
        idempotencyKey: `reply-${handoff.id}`,
      });
      await saveHandoff({
        ...handoff,
        reply: {
          id,
          digest,
          text: messagePreview(text),
          at: new Date().toISOString(),
        },
      });
      await invalidate(HANDOFF_TOPICS);
      return { message: "Reply sent to the project that asked." };
    }),
  );

  ctx.handle(`view:${ASKED}:read`, async (input, invocation) => {
    // Card data grants nothing: a handoff answers only in the conversation that asked.
    const threadId = invocation.context?.threadId;
    const handoff = (await readHandoffs()).handoffs.find(
      (entry) =>
        entry.id === input?.handoffId && entry.from.threadId === threadId,
    );
    if (!threadId || !handoff) return { data: null };
    const { projectId } = handoff.to;
    const { projects } = await listProjects(invocation, { calls: SCAN_PAGES });
    const project = projects.get(projectId);
    const { threads } = project
      ? await listThreads(projectId, invocation, { calls: SCAN_PAGES })
      : { threads: [] };
    return { data: askedRow(handoff, project, threads) };
  });

  ctx.handle(`view:${VIEW}:read`, async (_input, invocation) => {
    const { thread, projectId, coordinator } =
      await overviewContext(invocation);
    // A worker elsewhere opens its launcher's panel, but that project's messages stay in that project.
    const handoffs =
      coordinator && thread.projectId === projectId
        ? (await readHandoffs()).handoffs.filter(
            (entry) => entry.from.threadId === coordinator.id,
          )
        : [];
    const [{ notes }, scan] = await Promise.all([
      readMemory(projectId),
      coordinator
        ? scanAccessible(invocation, { calls: READ_BUDGET }, [
            projectId,
            ...handoffs.map((entry) => entry.to.projectId),
          ])
        : listProjects(invocation, { calls: SCAN_PAGES }),
    ]);
    const others = coordinator
      ? otherProjects(handoffs, coordinator.id, scan.threads, scan.projects)
      : [];
    const threadsView = coordinator
      ? overview(scan.threads, coordinator.id, scan.projects)
      : null;
    return {
      data: {
        projectId,
        project: scan.projects.get(projectId)?.title ?? null,
        coordinator: coordinator && { threadId: coordinator.id },
        current: thread.id,
        scan: coordinator ? { complete: scan.complete } : null,
        overview: threadsView,
        summary: threadsView && overviewSummary(threadsView.status, others),
        others,
        notes,
      },
    };
  });

  ctx.handle(`view:${VIEW}:remember`, async (input, invocation) => {
    const { thread, projectId } = await overviewContext(invocation);
    const { notes } = await addNote(projectId, {
      id: hashId("person", invocation.operationId).slice(0, 16),
      text: noteText(input?.text),
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    return { data: { notes } };
  });

  ctx.handle(`view:${VIEW}:forget`, async (input, invocation) => {
    const { projectId } = await overviewContext(invocation);
    const notes = await serial(async () => {
      const memory = await readMemory(projectId);
      const next = {
        ...memory,
        notes: memory.notes.filter((note) => note.id !== input?.id),
      };
      await ctx.storage.set(memoryKey(projectId), next);
      return next.notes;
    });
    await invalidate([`view:${VIEW}`]);
    return { data: { notes } };
  });

  // Like Claude Code Projects' Overview button, the chip is the same on the coordinator and on
  // every thread it started, so the Overview is one click away wherever the person is.
  ctx.handle(`status:${VIEW}`, async (_input, invocation) => {
    const { thread, projectId, coordinator } =
      await overviewContext(invocation);
    if (!coordinator || thread.archivedAt) return { data: null };
    const coordinatorId = coordinator.id;
    if (thread.id !== coordinatorId && !isWorker(thread, coordinatorId))
      return { data: null };
    const scan = await scanAccessible(invocation, { calls: READ_BUDGET }, [
      projectId,
    ]);
    // Pages follow thread ids, not activity, so a partial count could hide running work.
    if (!scan.complete)
      return {
        data: { label: "Partial scan · Open Overview", tone: "warning" },
      };
    const listedCoordinator = scan.threads.find((t) => t.id === coordinatorId);
    if (!listedCoordinator || listedCoordinator.archivedAt)
      return { data: null };
    return { data: overview(scan.threads, coordinatorId).status };
  });

  ctx.trees.register(TREE, async (invocation) => {
    // One call goes to reading the stored coordinators.
    const budget = { calls: TREE_BUDGET - 1 };
    const store = await readCoordinators();
    const scan = await scanAccessible(
      invocation,
      budget,
      Object.keys(store.projects),
    );
    const now = Date.now();
    const sections = [];
    const exclusive = projectsView();
    // Workers may live in any granted project, including ones without their own conversation.
    const candidates = [...scan.projects.values()]
      .filter((project) => scan.scanned.has(project.id))
      .sort((a, b) => a.title.localeCompare(b.title));
    // Only ids this call just listed: one stale reference would make the host reject the tree.
    for (const project of candidates) {
      sections.push(
        projectSection(
          project.id,
          scan.threads,
          store.projects[project.id]?.threadId,
          now,
          // Only a conversation heading may hold another project's thread, so without one a
          // worker stays in its own project: the host would reject the whole tree otherwise.
          { crossProject: conversations() },
        ),
      );
    }
    // A cross-project worker belongs under its launcher, never again under its working project.
    // A project's own conversation keeps its heading if it was itself launched by another one.
    const coordinatorIds = new Set(
      sections.flatMap((s) => (s.coordinator ? [s.coordinator.id] : [])),
    );
    const placed = new Set();
    for (const section of sections) {
      section.workers = section.workers.filter(
        (t) => !coordinatorIds.has(t.id),
      );
      section.done = section.done.filter((t) => !coordinatorIds.has(t.id));
      for (const thread of [...section.workers, ...section.done])
        placed.add(thread.id);
    }
    for (const section of sections)
      section.others = section.others.filter((t) => !placed.has(t.id));
    if (!scan.complete)
      ctx.log(
        "debug",
        "The Projects scan is partial; only accessible, scanned threads are placed.",
      );
    // Conversations started before the Projects view owned them move out of Activity.
    for (const section of sections)
      if (section.coordinator && budget.calls > 0) {
        budget.calls--;
        await adopt(section.coordinator);
      }
    // Hosts without conversation headings would reject the fields, so they go only where granted.
    return buildTree(sections, {
      openAction: conversations() ? "open-conversation" : undefined,
      coordinatorsOnly: exclusive,
    });
  });
}
