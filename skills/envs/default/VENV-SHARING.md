# Skills Env Sharing

`env/` is the reproducible runtime scaffold inside the `entelecheia/skills`
repo. In the workspace checkout its path is:

```bash
~/workspace/work/_sys/skills/env
```

In a standalone clone of the skills repo, the same files live at repo-local
`env/`.

## Discovery

Scripts and hooks resolve the env by walking upward from the current project or
skill directory and checking these candidates:

1. `<ancestor>/env/.venv`
2. `<ancestor>/_sys/skills/env/.venv`
3. `<ancestor>/skills/env/.venv`

`SKILL_PYTHON` may override discovery for one command.

## Provisioning

```bash
cd ~/workspace/work/_sys/skills/env
make setup
make verify
```

The tracked source of truth is `pyproject.toml`, `uv.lock`, `package.json`, and
`pnpm-lock.yaml`. Runtime outputs are ignored: `.venv/`, `jre/`,
`node_modules/`, `input/`, `output/`, `temp/`, and `logs/`.

## Session Hook

`env/.claude/hooks/init-env.sh` is the shared SessionStart hook. It writes
`VIRTUAL_ENV`, `PATH`, and optional `NODE_PATH` into `CLAUDE_ENV_FILE` so later
tool calls use the same runtime.

Use `env/scripts/infuse-hooks.sh --all` from the workspace checkout to refresh
submodule-local `.claude` hooks.
