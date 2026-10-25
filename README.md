# Project Coordinator for T3 Code

A [T3 Code](https://github.com/pingdotgg/t3code) plugin that gives each project one long-running
**coordinator** thread. You talk to the coordinator. It scopes the goal, hands the pieces to
parallel workers through T3's own orchestration tools, reviews what comes back, and assembles it.
The sidebar groups its workers into **Needs you**, **Working**, **Ready for review** and **Done**.
Agents share a short project memory.

The plugin is small on purpose. T3 already runs, isolates, and reports back on delegated work.
This plugin starts the coordinator with a good brief, recognizes its workers, shows where they
stand, and keeps the memory. It never starts a worker itself.

## Install

The T3 server needs the plugin host with API v1 and native sidebar trees.

1. Open **Settings → Plugins**, choose the environment, and install this directory by its absolute
   path on the server machine (or its Git URL).
2. Review it, grant the projects you want to coordinate, and approve.

## Use it

- Run **Open project coordinator** from the command palette or a thread's menu. It opens the
  project's coordinator, starting one if there is none. The coordinator reads the project memory
  and asks what you want to accomplish.
- The coordinator delegates each piece with `delegate_task` in its own worktree. Results arrive in
  the coordinator's thread automatically, and it reviews them before accepting.
- Choose **Coordinator** in the sidebar's view menu (the **View** menu on mobile) to see every
  coordinator with its workers grouped by state. The groups update as workers start, stop, or
  wait for you.
- The coordinator and its workers show a **Coordinator** status in the thread header, such as
  **Coordinator · 1 needs you · 2 working**. Select it for the panel.
- The panel lists the project memory. You can add or remove notes there.

To retire a coordinator, archive its thread. The next **Open project coordinator** starts a new one.

### What the states mean

| State            | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| Needs you        | A pending approval or question, or a failed run                      |
| Working          | A run is in progress                                                 |
| Ready for review | Not running and not settled: the coordinator hasn't accepted it yet  |
| Done             | Settled, by the coordinator after review or by T3 (merged PR, idle)  |

A worker is a `delegate_task` child of the coordinator, or a thread the coordinator started with
`t3_thread_launch` or `create_threads`. A worker's own sub-agents nest under it.

## For agents

Agents find these with `t3_plugin_list` and call them with `t3_plugin_invoke`. Memory always belongs
to the calling thread's project.

| Action          | Input      | What it does                                               |
| --------------- | ---------- | ---------------------------------------------------------- |
| `memory-read`   | `{}`       | Returns the project's notes, oldest first                  |
| `memory-append` | `{ text }` | Adds one note (up to 1,000 characters; 16 KB per project)  |

The coordinator reads memory before planning and passes the relevant notes into each worker's brief,
since a delegated worker sees only its brief.

## Why there is no completion relay

Delegated workers already report to the coordinator when they finish, so the plugin doesn't send a
second notice. A thread started with `t3_thread_launch` is one you asked to drive yourself. Its
finished runs are yours, and relaying every one would wake the coordinator for your own
conversation. The run-finalized event can't tell who started a run.

## Waiting on the host

These need T3 changes, so the plugin doesn't work around them:

- **Workers in other environments.** Waits on T3's linked-environment MCP work.
- **Memory in every run automatically.** Needs a host hook that adds context before a run starts.
  Until then, the coordinator includes memory in each brief.
- **A cloud runtime** for coordinators that keep working while your machine is off.

## Development

```sh
node --test tests/
```

The tests run the plugin against a fake host that keeps the real host's rules: deleted threads
read as denied, pages cap at 200, and an invocation gets at most 100 host calls.

## License

MIT
