# Project Coordinator for T3 Code

A [T3 Code](https://github.com/pingdotgg/t3code) plugin that gives each project one long-running
**coordinator** thread. You talk to the coordinator. It scopes the goal, hands the pieces to
parallel threads through T3's own orchestration tools, reviews what comes back, and assembles it.
A **Projects** tab in the sidebar shows each coordinator with the threads it started nested under
it. Agents share a short project memory.

The plugin is small on purpose. T3 already runs, isolates, and reports back on delegated work.
This plugin starts the coordinator, gives it a playbook, places its threads in the sidebar, sums up
where they stand, and keeps the memory. It never starts a thread itself.

## Install

The T3 server needs the plugin host with API v1, including native sidebar trees.

1. Open **Settings → Plugins**, choose the environment, and install this directory by its absolute
   path on the server machine (or its Git URL).
2. Review it, grant the projects you want to coordinate, and approve.
3. In the sidebar, select the **Projects** tab (the tree button next to Search). T3 remembers the
   choice on this device. T3's default Activity tab hides delegated threads, so the coordinator's
   threads only show in Projects.

## Use it

- Run **Open project coordinator** from the command palette or a thread's menu. It opens the
  project's coordinator, starting one if there is none. The coordinator reads the project memory
  and asks what you want to accomplish.
- The coordinator hands each piece to a thread with `delegate_task`, in its own worktree. Each one
  appears in the **Projects** tab nested under the coordinator, in the order it was started, with
  T3's own status on its row: working, waiting on you, finished. Its result comes back to the
  coordinator, which reviews it and settles it once accepted.
- The coordinator's header shows **Project** with a short summary, such as **Project · 2 working ·
  1 ready for review**. It reads **Waiting on you** first when anything, the coordinator included,
  has a pending approval or question. Select it to open the **Project** panel, where you can add
  or remove memory notes.

The tab lists every granted project: its coordinator first, then the project's other live threads
by recent activity. Settled and snoozed top-level threads stay on T3's shelves, as in Activity; a
parked fork or sub-thread still follows its parent row. Finished workers stay in place until more
than five of them would bury the rest; the oldest then fold into one collapsed **Done** group just
below the coordinator.

To retire a coordinator, archive its thread. The next **Open project coordinator** starts a new one.

### What the summary counts

| State            | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Waiting on you   | A pending approval or question, or a failed run                     |
| Working          | A run is in progress                                                |
| Ready for review | Finished and not settled: the coordinator hasn't accepted it yet    |
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

A new coordinator's first message is one line asking it to read the guide. The playbook lives in
the `guide` action rather than the thread, so a long-running coordinator can reread it after its
conversation is compacted. The coordinator reads memory before planning and passes the relevant
notes into each worker's brief, since a delegated worker sees only its brief.

## Why there is no completion relay

Delegated workers already report to the coordinator when they finish, so the plugin doesn't send a
second notice. A thread started with `t3_thread_launch` is one you asked to drive yourself. Its
finished runs are yours, and relaying every one would wake the coordinator for your own
conversation. The run-finalized event can't tell who started a run.

## Waiting on the host

These need T3 changes, so the plugin doesn't work around them:

- **Switching to the Projects tab for you.** No plugin intent selects a sidebar tab, so you pick
  it once.
- **Workers in other environments.** Waits on T3's linked-environment MCP work.
- **Memory in every run automatically.** Needs a host hook that adds context before a run starts.
  Until then, the coordinator includes memory in each brief.
- **A question asked in plain text.** T3 only flags a thread as waiting for a pending approval or
  question request, so when the coordinator asks "Shall I merge?" in its reply, the summary still
  reads **All threads done**.
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
