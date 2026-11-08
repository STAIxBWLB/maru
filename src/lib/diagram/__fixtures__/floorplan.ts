/**
 * A trimmed copy of the ahub family Floorplan map published at
 * https://afam.staix.net/explore/map/ (the source repository is private; the
 * content is the published map): 21 of its 53 nodes, with the edges, flow
 * steps and tour stops among them. `floorplan/architecture@1` verbatim; no
 * local paths. Issue #535.
 */

export const FLOORPLAN_FIXTURE: Record<string, unknown> = {
  "$schema": "floorplan/architecture@1",
  "audience": "developers",
  "project": {
    "name": "ahub family",
    "summary": "Five separately installable Bun packages: ahub coordinates agents, amem keeps project memory, vmem validates durable knowledge, ares runs evidence-backed studies, and acon presents all of them in one console. Each tool owns its own state; the links between them are imports, CLI calls and console plugins, all optional.",
    "entrypoints": [
      "agent-hub/src/cli/main.ts",
      "agent-mem/src/cli.ts",
      "vault-mem/src/cli.ts",
      "agent-research/src/cli.ts",
      "agent-console/src/cli.ts"
    ]
  },
  "ignore": [
    "agent-console/shell/vendor/**"
  ],
  "nodes": [
    {
      "id": "ahub",
      "label": "ahub (agent-hub)",
      "kind": "service",
      "summary": "Per-project daemon that lets Claude Code, Codex, Kimi, Qwen, Jcode, Pi and a local worker work as peers through one message bus and task board.",
      "paths": [
        "agent-hub/**"
      ]
    },
    {
      "id": "ahub.cli",
      "parent": "ahub",
      "label": "ahub CLI and console",
      "kind": "ui",
      "summary": "The `ahub` command: setup, init, up, the terminal console and every person-only command.",
      "paths": [
        "agent-hub/src/cli/**",
        "agent-hub/src/*.ts"
      ]
    },
    {
      "id": "ahub.hub",
      "parent": "ahub",
      "label": "Hub daemon",
      "kind": "service",
      "summary": "The loopback daemon: configuration, peers, lifecycle, recovery and everything not split out below.",
      "paths": [
        "agent-hub/src/hub/**"
      ]
    },
    {
      "id": "ahub.hub.tasks",
      "parent": "ahub.hub",
      "label": "Task board and review",
      "kind": "feature",
      "summary": "Tasks, owners and reviewers, roles, routing, handoff between projects, questions, schedules and the review record.",
      "paths": [
        "agent-hub/src/hub/{tasks,task-*,board,planning,roles,settled-roles,shipped-roles,roster,routing,reviewer-pool*,review-*,conductor,handoff,intake,github-import,schedules,cohorts,conflicts,workflow,completion*,completions*,deliverable*,report,question*,plan-conformance,progress}.ts"
      ],
      "exclude": [
        "agent-hub/src/hub/task-shell-*.ts",
        "agent-hub/src/hub/task-worktree.ts"
      ]
    },
    {
      "id": "ahub.hub.bus",
      "parent": "ahub.hub",
      "label": "Message bus and delivery",
      "kind": "feature",
      "summary": "Envelopes, the delivery journal and its states, inbox polling, rate limits and backpressure. Delivery state is transport only; it never decides task state.",
      "paths": [
        "agent-hub/src/hub/{bus,delivery-*,envelope,events,inbox-polling,queue-backpressure,limits,protocol-window,channel-project,listen,invocations,room-invocations}.ts"
      ]
    },
    {
      "id": "ahub.hub.memory",
      "parent": "ahub.hub",
      "label": "Hub memory bridge",
      "kind": "feature",
      "summary": "How the hub uses the embedded amem library: remember, recall prefaces, task briefs, candidates, staleness and sync policy.",
      "paths": [
        "agent-hub/src/hub/{memory-*,learning}.ts",
        "agent-hub/src/memory/**"
      ]
    },
    {
      "id": "ahub.adapters",
      "parent": "ahub",
      "label": "Peer adapters",
      "kind": "library",
      "summary": "One adapter per agent kind, attaching through its native surface: Claude channel plugin, Codex app-server, ACP for Kimi/Qwen/Jcode, Pi RPC, Antigravity.",
      "paths": [
        "agent-hub/src/adapters/**"
      ]
    },
    {
      "id": "ahub.ui",
      "parent": "ahub",
      "label": "Dashboard and acon plugin",
      "kind": "ui",
      "summary": "The local dashboard page and the ui-plugin module acon loads to show hub panels, inbox items and the Space view.",
      "paths": [
        "agent-hub/src/ui/**",
        "agent-hub/src/pet/**"
      ]
    },
    {
      "id": "amem",
      "label": "amem (agent-mem)",
      "kind": "library",
      "summary": "Screened project memory for coding agents: curated notes, a separate capture tier, recall, candidates and optional git sync.",
      "paths": [
        "agent-mem/**"
      ]
    },
    {
      "id": "amem.cli",
      "parent": "amem",
      "label": "amem CLI",
      "kind": "ui",
      "summary": "The `amem` command, including the person-only review that turns candidates into notes.",
      "paths": [
        "agent-mem/src/{cli*,commands-table,completion}.ts",
        "agent-mem/bin/**"
      ]
    },
    {
      "id": "amem.core",
      "parent": "amem",
      "label": "Memory core",
      "kind": "library",
      "summary": "The library other tools import: stores, screening, recall and lifecycle.",
      "paths": [
        "agent-mem/src/memory/**",
        "agent-mem/src/index.ts"
      ]
    },
    {
      "id": "amem.core.candidates",
      "parent": "amem.core",
      "label": "Candidates and vault list",
      "kind": "feature",
      "summary": "Proposed notes waiting for review, consolidation, goals and the vault-candidate list vmem reads.",
      "paths": [
        "agent-mem/src/memory/{candidate*,consolidat*,goal-promotion,vault,decay-review,work-lists,external-import,import,migrate,commands,cli-attribution,config,doctor,bridge,mutation-*}.ts"
      ]
    },
    {
      "id": "amem.ui",
      "parent": "amem",
      "label": "acon plugin",
      "kind": "ui",
      "summary": "Memory panels and inbox items for acon, including the Review panel.",
      "paths": [
        "agent-mem/src/ui/**"
      ]
    },
    {
      "id": "vmem",
      "label": "vmem (vault-mem)",
      "kind": "library",
      "summary": "Validated, Obsidian-compatible knowledge vaults: every write passes one rule set or nothing is written.",
      "paths": [
        "vault-mem/**"
      ]
    },
    {
      "id": "vmem.promote",
      "parent": "vmem",
      "label": "Promotion",
      "kind": "feature",
      "summary": "Preview-and-fingerprint promotion from amem candidates and between vaults, recording provenance.",
      "paths": [
        "vault-mem/src/{promote-command,org-*,skills-mine}.ts",
        "vault-mem/src/amem/**"
      ],
      "exclude": [
        "vault-mem/src/org-commands.ts"
      ]
    },
    {
      "id": "vmem.ui",
      "parent": "vmem",
      "label": "acon plugin",
      "kind": "ui",
      "summary": "Vault panels for acon; actions go through vmem's preview step.",
      "paths": [
        "vault-mem/src/ui/**"
      ]
    },
    {
      "id": "acon",
      "label": "acon (agent-console)",
      "kind": "service",
      "summary": "Local-first web console that loads each tool's own plugin, merges their inboxes and routes every decision back to the owning tool.",
      "paths": [
        "agent-console/**"
      ]
    },
    {
      "id": "acon.server",
      "parent": "acon",
      "label": "Console server",
      "kind": "service",
      "summary": "`acon ui` (loopback, one-time link) and `acon serve` (auth required off loopback), sessions and confirm tokens.",
      "paths": [
        "agent-console/src/**",
        "agent-console/bin/**"
      ]
    },
    {
      "id": "acon.plugins",
      "parent": "acon.server",
      "label": "Plugin host",
      "kind": "feature",
      "summary": "Verifies each registered plugin (hash, ownership, import boundary), loads it and calls its action() for decisions.",
      "paths": [
        "agent-console/src/{plugins,contract,conformance,canonical,install,setup}.ts"
      ]
    },
    {
      "id": "acon.shell",
      "parent": "acon",
      "label": "Browser shell",
      "kind": "ui",
      "summary": "The page: unified inbox, provider panels, palette, Space view and static shell.",
      "paths": [
        "agent-console/shell/**"
      ]
    },
    {
      "id": "github",
      "label": "GitHub",
      "kind": "external",
      "summary": "Repositories, PRs, CI and issues used by ahub's worktree, review and import features.",
      "hosts": [
        "github.com",
        "api.github.com"
      ]
    }
  ],
  "edges": [
    {
      "from": "ahub.hub.memory",
      "to": "amem.core",
      "kind": "import",
      "label": "embeds @staix/agent-mem",
      "description": "ahub imports amem in-process (exact version pin); hub_remember writes curated notes, recall prefaces and briefs read them. Source: agent-hub package.json and src/memory/client.ts."
    },
    {
      "from": "vmem.promote",
      "to": "amem.core.candidates",
      "kind": "import",
      "label": "reads candidates, records link",
      "description": "vmem reads amem vault candidates and, after a confirmed write, records only the vault link back in amem. amem never writes a vault."
    },
    {
      "from": "acon.plugins",
      "to": "ahub.ui",
      "kind": "rpc",
      "label": "loads plugin, routes decisions",
      "description": "acon imports ahub's registered ui-plugin and calls its action(); ahub executes through its own manager port."
    },
    {
      "from": "acon.plugins",
      "to": "amem.ui",
      "kind": "rpc",
      "label": "loads plugin, routes decisions",
      "description": "Review decisions run amem's own review logic."
    },
    {
      "from": "acon.plugins",
      "to": "vmem.ui",
      "kind": "rpc",
      "label": "loads plugin, routes decisions",
      "description": "Vault actions go through vmem's preview and fingerprint; acon never writes the vault."
    },
    {
      "from": "ahub.adapters",
      "to": "ahub.hub.bus",
      "kind": "event",
      "label": "deliveries",
      "description": "Each adapter turns bus deliveries into native turns and reports outcomes."
    }
  ],
  "flows": [
    {
      "id": "agent-team",
      "title": "Build with an agent team",
      "description": "A task goes from proposal to review. Delivered, done, reviewed and released are different facts.",
      "steps": [
        {
          "node": "ahub.cli",
          "note": "A person or planner proposes work; the hub picks an owner and a reviewer from roles and routing."
        },
        {
          "node": "ahub.hub.tasks",
          "note": "The task is recorded on the board; the owner accepts it."
        },
        {
          "node": "ahub.hub.bus",
          "note": "The assignment is delivered. A delivery state like completed means the message arrived, not that the work is done."
        },
        {
          "node": "ahub.adapters",
          "note": "The owner works in its native CLI and calls hub_task_done with the change and the check it ran: the task moves to in_review."
        },
        {
          "node": "ahub.hub.tasks",
          "note": "The reviewer records approved or changes_requested. Release is a separate train, not a task state."
        },
        {
          "node": "acon.shell",
          "note": "Pending decisions and reviews appear in acon's inbox through ahub's plugin."
        }
      ]
    }
  ],
  "tour": [
    {
      "node": "ahub",
      "title": "Coordination",
      "note": "ahub is the daemon each project runs; agents attach to it as peers."
    },
    {
      "node": "amem",
      "title": "Project memory",
      "note": "amem is a library and CLI; ahub embeds it, ares calls its CLI."
    },
    {
      "node": "vmem",
      "title": "Durable knowledge",
      "note": "vmem owns validated vault writes and promotion from amem."
    },
    {
      "node": "acon",
      "title": "One console",
      "note": "acon loads each tool's own plugin and sends decisions back to that tool."
    }
  ]
};
