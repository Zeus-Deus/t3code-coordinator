# Project Coordinator for T3 Code

A [T3 Code](https://github.com/pingdotgg/t3code) plugin, in the style of Claude Code Projects: each
project is one conversation. You say what you want, and the coordinator splits it into threads that
run in parallel, nested under the project, then reviews and merges their work.

![Three workers run in parallel under the Shelf project, with the Overview beside the conversation](docs/screenshots/workers.png)

## What you get

- **A Projects tab.** It lists the projects you've started, most recent first. Click one to open its
  conversation. Its threads nest underneath it with their live status.
- **One conversation per project.** The coordinator plans the work, hands each piece to a thread in
  its own worktree, reviews what comes back, and asks before merging.
- **An Overview** beside the conversation. It groups threads into Ready for review, Waiting on you,
  Working and Done, and holds a short **project memory** that every thread gets.
- **Activity stays your inbox.** Project conversations and their threads show only in the Projects
  tab.

| Start a project                                                                       | Merged and done                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ![A new project opens empty and asks what to build](docs/screenshots/new-project.png) | ![All workers done; the coordinator merged three branches and all tests pass](docs/screenshots/merged.png) |

## Install

This needs a T3 Code build with the plugin system. It isn't in official T3 Code yet, so for now use
the [`plugin-system` branch](https://github.com/Zeus-Deus/t3code/tree/plugin-system).

1. Clone this repo.
2. In T3 Code, open **Settings → Plugins** and install the folder by its path, or install it from
   this repo's Git URL.
3. Review the permissions, grant the projects you want to coordinate, and approve.
4. In the sidebar, pick the **Projects** tab, then **+ New project**.

## Good to know

- **Removing a project** archives its conversation, keeping its history and memory. Adding it again
  brings the same conversation back.
- **Disabling the plugin** puts those conversations back in Activity, so nothing is lost.
- **Agents** can read the playbook and the project memory through `t3_plugin_invoke`, using the
  `guide`, `memory-read` and `memory-append` actions.

## Development

```sh
node --test tests/
```

## License

MIT
