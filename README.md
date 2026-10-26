# Project Coordinator for T3 Code

A [T3 Code](https://github.com/pingdotgg/t3code) plugin that gives each project one long-running
**coordinator** thread. You talk to the coordinator. It scopes the goal, hands the pieces to
parallel workers through T3's own orchestration tools, reviews what comes back, and assembles it.
An **Overview** beside the conversation shows which threads are ready for review, waiting on
you, working or done. Agents share a short project memory.

The plugin is small on purpose. T3 already runs, isolates, and reports back on delegated work.
This plugin starts the coordinator, gives it a playbook, recognizes its workers, shows where they
stand, and keeps the memory. It never starts a worker itself.

## Install

The T3 server needs the plugin host with API v1, including live view updates and `view.open`
beside a given thread.

1. Open **Settings → Plugins**, choose the environment, and install this directory by its absolute
   path on the server machine (or its Git URL).
2. Review it, grant the projects you want to coordinate, and approve.

## Use it

- Run **Open project coordinator** from the command palette or a thread's menu. It opens the
  project's coordinator, starting one if there is none, with the **Overview** beside it. The
  coordinator reads the project memory and asks what you want to accomplish.
- The coordinator hands each piece to a thread with `delegate_task`, in its own worktree. T3 shows
  each one in the conversation, and its result comes back to the coordinator, which reviews it
  before accepting.
- The **Overview** groups those threads by state and updates as they start, stop or wait for you.
  Select a thread to open it with the Overview still beside it; **Coordinator** at the top of the
  Overview, or the breadcrumb, takes you back.
- The thread header shows **Overview** with a short status, such as **Overview · 1 waiting on
  you**. Select it to open the Overview. It reads **Waiting on you** when the coordinator itself
  has a pending approval or question.
- The gear in the Overview opens the **Project memory**. You can add or remove notes there.

T3's sidebar is unchanged: the coordinator is one row in its project, and the threads it delegates
stay out of the Activity list.

To retire a coordinator, archive its thread. The next **Open project coordinator** starts a new one.

### What the states mean

| State            | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Ready for review | Finished and not settled: the coordinator hasn't accepted it yet    |
| Waiting on you   | A pending approval or question, or a failed run                     |
| Working          | A run is in progress                                                |
| Done             | Settled, by the coordinator after review or by T3 (merged PR, idle) |

Threads keep the order they were started in, so a row never jumps when another changes state.

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

- **A thread's transcript inside the Overview.** T3's right panel has no thread surface, so a
  thread opens in the main view with the Overview beside it.
- **Workers in other environments.** Waits on T3's linked-environment MCP work.
- **Memory in every run automatically.** Needs a host hook that adds context before a run starts.
  Until then, the coordinator includes memory in each brief.
- **A question asked in plain text.** T3 only flags a thread as waiting for a pending approval or
  question request, so when the coordinator asks "Shall I merge?" in its reply, the Overview still
  reads **All threads done**.
- **A cloud runtime** for coordinators that keep working while your machine is off.

## Development

```sh
node --test tests/
```

The tests run the plugin against a fake host that keeps the real host's rules: deleted threads
read as denied, pages cap at 200, and an invocation gets at most 100 host calls.

## License

MIT
