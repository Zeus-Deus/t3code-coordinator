# Project Coordinator for T3 Code

A [T3 Code](https://github.com/pingdotgg/t3code) plugin that makes each project a conversation.
Click the project in the **Projects** tab and you are talking to its **coordinator**: it scopes the
goal, hands the pieces to parallel threads through T3's own orchestration tools, reviews what comes
back, and assembles it. Those threads nest under the project in the sidebar. An **Overview** beside
the conversation groups them by state, and agents share a short project memory.

The plugin is small on purpose. T3 already runs, isolates, and reports back on delegated work.
This plugin opens the coordinator, gives it a playbook, places its threads in the sidebar, sums up
where they stand, and keeps the memory. It never starts a thread itself.

## Install

The T3 server needs the plugin host with API v1, including native sidebar trees. The project as
the conversation needs a host with conversation headings (`ui.native-tree-conversations`), which
also lets the conversation start empty, with the coordinator's brief travelling with your first
message. With project trees (`ui.native-tree-projects`) the **Projects** tab becomes its own view,
like Claude Code Projects: it lists only projects you've started a conversation in, and those
conversations leave T3's Activity list. On older hosts the coordinator is a row under the project,
started from the command palette with a short kickoff message.

1. Open **Settings → Plugins**, choose the environment, and install this directory by its absolute
   path on the server machine (or its Git URL).
2. Review it, grant the projects you want to coordinate, and approve.
3. In the sidebar, select the **Projects** tab (the tree button next to Search). T3 remembers the
   choice on this device. Activity stays T3's inbox for everything else: it hides delegated
   threads, and with project trees the conversations too. Disable or remove the plugin and the
   conversations return to Activity; search and the command palette always find them.

## Use it

- **New project** at the top of the **Projects** tab opens T3's project picker: choose a project
  or add a folder. If the plugin hasn't been granted that project, T3 asks once. Its
  conversation then opens; an empty tab shows just the button and one line.
- In the **Projects** tab, click a project's name to open its conversation. The first time, it
  opens empty with the **Overview** beside it, asking what to build; nothing runs until you write.
  **View** above the composer shows the brief the plugin adds to your first message, and the sent
  message keeps an **Includes Project Coordinator's brief** disclosure. The project row shows the
  conversation's status and is selected while it is open; its chevron folds the threads.
  **Open project coordinator** in the command palette or a thread's menu does the same.
- The coordinator hands each piece to a thread with `delegate_task`, in its own worktree. Each one
  appears under the coordinator's message as T3's subagent card, and in the **Projects** tab nested
  under the project, in the order it was started, with T3's own status on its row. Its result
  comes back to the coordinator, which reviews it and settles it once accepted. Settle and
  un-settle any thread yourself from its row or menu.
- The header of the conversation and of every thread it started shows **Overview** with a short
  summary, such as **Overview · 2 working · 1 ready for review**. It turns to the warning colour
  and leads with **1 waiting on you** when a thread, or the coordinator itself, has a pending
  approval or question or a failed run. Select it to open the **Overview**: the threads grouped by
  state, which open with the Overview still beside them, and the project memory, where you can add
  or remove notes.

With project trees the tab lists projects that have a conversation, most recently active first,
and nothing else; other threads stay in Activity. On older hosts it lists every granted project,
with its other live threads after the coordinator's. Finished workers stay in place until more
than five of them would bury the rest; the oldest then fold into one collapsed **Done** group
under the project.

**Removing a project** from the tab is T3's own archive of its conversation (the project row's
thread menu). History and project memory are kept. **New project** on the same project, or
unarchiving the thread, brings back that same conversation; a new one starts only if the old one
was deleted. If the plugin can't tell what happened to it, it stops and says so instead of
starting a second one.

### What the Overview groups

| State            | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Ready for review | Finished and not settled: the coordinator hasn't accepted it yet    |
| Waiting on you   | A pending approval or question, or a failed run                     |
| Working          | A run is in progress                                                |
| Done             | Settled, by the coordinator after review or by T3 (merged PR, idle) |

A thread counts when it is a `delegate_task` child of the coordinator, or one the coordinator
started with `t3_thread_launch` or `create_threads`. A thread's own sub-agents are its business.

## For agents

Agents find these with `t3_plugin_list` and call them with `t3_plugin_invoke`. Memory always belongs
to the calling thread's project.

| Action          | Input      | What it does                                              |
| --------------- | ---------- | --------------------------------------------------------- |
| `guide`         | `{}`       | Returns the coordinator's playbook                        |
| `memory-read`   | `{}`       | Returns the project's notes, oldest first                 |
| `memory-append` | `{ text }` | Adds one note (up to 1,000 characters; 16 KB per project) |

The coordinator's brief carries the whole playbook and travels with your first message. The `guide`
action returns the same playbook, so a long-running coordinator can reread it after its
conversation is compacted. The coordinator reads memory before planning and passes the relevant
notes into each worker's brief, since a delegated worker sees only its brief.

## Why there is no completion relay

Delegated workers already report to the coordinator when they finish, so the plugin doesn't send a
second notice. A thread started with `t3_thread_launch` is one you asked to drive yourself. Its
finished runs are yours, and relaying every one would wake the coordinator for your own
conversation. The run-finalized event can't tell who started a run.

## Waiting on the host

These need T3 changes, so the plugin doesn't work around them:

- **The breadcrumb outside the Projects tab.** Opened from Activity or search, a conversation's
  header reads "Shelf / Shelf", since only the Projects tab knows the row is the project.
- **Workers in search.** T3's search and palette leave out every delegated thread, so a worker is
  reached through its project or the conversation's subagent cards.
- **Switching to the Projects tab for you.** No plugin intent selects a sidebar tab, so you pick
  it once.
- **A thread's transcript inside the Overview.** T3's right panel has no thread surface, so a
  thread opens in the main view with the Overview beside it.
- **Workers in other environments.** Waits on T3's linked-environment MCP work.
- **Memory in every run automatically.** Needs a host hook that adds context before a run starts.
  Until then, the coordinator includes memory in each brief.
- **A question asked in plain text.** T3 only flags a thread as waiting for a pending approval or
  question request, so when the coordinator asks "Shall I merge?" in its reply, the summary still
  reads **All workers done**.
- **A cloud runtime** for coordinators that keep working while your machine is off.

## Development

```sh
node --test tests/
```

The tests run the plugin against a fake host that keeps the real host's rules: deleted threads
read as denied, pages cap at 200, and an invocation gets at most 100 host calls. A tree read
stays within 80.

## License

MIT
