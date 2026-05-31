# Skills Env Sharing

`envs/default/` is the reproducible runtime scaffold. `setup.sh --target
~/.anchor/env` provisions it into the canonical runtime:

```bash
~/.anchor/env        # .venv + node_modules + jre (provisioned, not in git)
```

In a standalone clone, the source scaffold lives at repo-local `envs/default/`.

## Discovery

Scripts and hooks resolve the env in this order (most-specific first):

1. `$SKILL_PYTHON` (caller override)
2. `$ANCHOR_SKILLS_ENV/.venv` (host-injected)
3. `~/.anchor/env/.venv` (canonical fixed location)
4. repo-local walk-up: `<ancestor>/{env,envs/default,skills/envs/default}/.venv` (dev-in-tree)
5. system `python3` (warning)

Ambient `$VIRTUAL_ENV` is not used for discovery. Wrappers set `VIRTUAL_ENV`
after the Anchor env is resolved.

See REFERENCE.md "Env resolution (canonical)" for the source-of-truth list.

## Provisioning

```bash
bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env
bash ~/.anchor/skills/_builtin/envs/default/setup.sh --verify --target ~/.anchor/env
```

The tracked source of truth is `pyproject.toml`, `uv.lock`, `package.json`, and
`pnpm-lock.yaml`. Runtime outputs are ignored: `.venv/`, `jre/`,
`node_modules/`, `input/`, `output/`, `temp/`, and `logs/`.

## Session Hook

`envs/default/.claude/hooks/init-env.sh` is the shared SessionStart hook. It
writes `ANCHOR_SKILLS_ENV`, `VIRTUAL_ENV`, `PATH`, and `NODE_PATH` into
`CLAUDE_ENV_FILE` so later tool calls use the same runtime (matching the Rust
host's `env_vars_for_runs`).

Register it globally in `~/.claude/settings.json` (SessionStart), or use
`scripts/infuse-hooks.sh --all` to refresh submodule-local `.claude` hooks.
