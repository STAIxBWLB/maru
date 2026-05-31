---
name: vault-graph
trigger: /vault-graph
description: >
  Graphify 기반 지식그래프 빌드·분석·질의 스킬. vault wiki-link 그래프와
  코드 AST 그래프를 모두 지원한다. `~/.anchor/skills/_builtin/lib/build-graph.py`를
  단일 빌더로 사용해 커뮤니티 탐지(Leiden), god node 분석, surprising
  connections, graphify MCP serve 안내를 제공한다.
---

# /vault-graph [command]

Knowledge graph build, query, report, and Graphify MCP setup for vault notes and code repos.

`vault-graph` owns the graph workflow.

## Shared Runtime

| Item | Path |
|------|------|
| Python | `~/.anchor/env/.venv/bin/python` |
| Builder | `~/.anchor/skills/_builtin/lib/build-graph.py` |
| Skill runner | `~/.anchor/skills/vault-graph/scripts/run.sh` |
| graphifyignore template | `<workspace-root>/_sys/templates/graphifyignore` |

## Commands

### Query Commands (ripgrep-based, always available)
- **orphans**: notes with no incoming links
- **hubs**: notes with most connections
- **domain [name]**: all notes in a domain
- **cross [domain1] [domain2]**: notes linking across domains
- **backlinks [note]**: all notes linking to a specific note
- **density**: connection density metrics
- **stale [days]**: notes not modified in N days

### Build Commands
- **build**: Run community detection + analysis pipeline. Outputs:
  - `vault/reports/vault-graph.json` (NetworkX graph)
  - `vault/reports/graph-report-YYMMDD.md` (audit report)
- **report**: Read the latest graph report (if < 7 days old)
- **communities**: List detected communities from latest build
- **surprises**: List cross-community surprising connections
- **god-nodes**: Show most-connected non-MOC nodes

## Build Process (`/vault-graph build`)

Options:
- `--vault`: build `<vault.path>` in wiki mode
- `--code <path>`: build a code repository in AST mode
- `<target>`: auto-detect wiki/code mode from a target directory

1. Resolve target and mode:
   - `--vault` → `<vault.path>`, `--mode wiki`
   - `--code <path>` → `<path>`, `--mode code`
   - no option → current directory, `--mode auto`
2. For code mode, ensure `.graphifyignore` exists. If missing, offer to copy `<workspace-root>/_sys/templates/graphifyignore`.
3. Execute:
   ```bash
   ~/.anchor/skills/vault-graph/scripts/run.sh \
     ~/.anchor/skills/_builtin/lib/build-graph.py \
     --target <path> --mode <wiki|code|auto>
   ```
4. Pipeline: read notes/code → extract graph → build NetworkX graph → Leiden/Louvain community detection → god node analysis → surprising connections → report.
5. Outputs:
   - vault: `<vault.path>/reports/vault-graph.json`, `<vault.path>/reports/graph-report-YYMMDD.md`
   - code: `<target>/graphify-out/graph.json`, `<target>/graphify-out/graph-report-YYMMDD.md`
6. For vault builds, append `GRAPH` event to `vault/log.md` via Obsidian MCP:
   ```
   YYYY-MM-DD HH:MM  GRAPH  -  vault/reports/graph-report-YYMMDD.md  — N notes, M communities, K surprises
   ```

## Report Process (`/vault-graph report [target]`)

1. Resolve report directory:
   - vault: `<vault.path>/reports/graph-report-*.md`
   - code: `<target>/graphify-out/graph-report-*.md`
2. Select newest report and warn if older than 7 days.
3. Read vault reports through Obsidian MCP and code reports through filesystem read.
4. Summarize overview, god nodes, top communities, surprising connections, and isolate count.

## Query Process (`/vault-graph query "<question>" [options]`)

Use graphify query against the selected `graph.json`.

```bash
~/.anchor/skills/vault-graph/scripts/run.sh \
  -m graphify query "<question>" \
  --graph <graph.json> [--dfs] [--budget N]
```

Options:
- `--graph <path>`: override graph path
- `--dfs`: use DFS instead of BFS
- `--budget N`: token budget, default 2000

## Setup Process (`/vault-graph setup [path]`)

1. Resolve target path, default current directory.
2. If `.graphifyignore` is missing, copy:
   ```bash
   cp <workspace-root>/_sys/templates/graphifyignore <target>/.graphifyignore
   ```
3. Run `/vault-graph build --code <target>`.
4. For large projects, optionally add project graph MCP config.

## Serve Process (`/vault-graph serve [graph_path]`)

1. Resolve `graph.json`, default `<vault.path>/reports/vault-graph.json`.
2. If missing, run `/vault-graph build` first.
3. Print MCP config block:
   ```json
   {
     "<project-name>-graph": {
       "command": "<skills-repo>/env/.venv/bin/python",
       "args": ["-c", "from graphify.serve import serve; serve('<graph_path>')"]
     }
   }
   ```

## Query Process (legacy)
1. Parse query type and parameters
2. Use ripgrep to scan vault/notes/ for wiki links and frontmatter
3. Build in-memory graph representation
4. Execute query
5. Format results

## Integration

- `/vault-connect` Step 0 reads graph report for connection candidates
- `/vault-sync` checks graph report for unconnected surprising connections
- `/vault-lint` checks L11 (graph staleness > 7 days), L12 (island communities)
- `skill-mine` imports the same builder primitives from `~/.anchor/skills/_builtin/lib/build-graph.py`
- CLAUDE.md §"Vault-First" Graph Report shortcut: T2/T3 ops read report before full vault search
