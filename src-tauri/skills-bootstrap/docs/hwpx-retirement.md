# HWPX skill retirement migration

The bundled `skills/hwpx` source tree was retired in favor of the single
official-document `hwp` skill exported by the released
[STAIxBWLB/hwp-cli v0.12.1](https://github.com/STAIxBWLB/hwp-cli/releases/tag/v0.12.1)
binary (commit `fa2d86776af7226b34a5a6f43081e8f3adef56c8`). The minimum supported
release is now
[`v1.2.0`](https://github.com/STAIxBWLB/hwp-cli/releases/tag/v1.2.0), commit
`05bf9ad005ffb5c18769df5fb0b5bf78afaec82b`. It keeps the untrusted-input fixes carried
through v1.0.0 (v0.20.2's HWPX nesting-depth bound and polynomial nested-table layout,
and v1.0.0's quick-xml 0.41 for RUSTSEC-2026-0194) and adds what Maru now relies on:
`hwp slots --forms`, which lists label cells and inline labels beside the slots;
`hwp fill --forms`, which also fills blanks and checkboxes; `hwp fill` matching padded
`{{ name }}` slots the way `hwp slots` lists them; and `--allow-partial` publishing a
fill that matched nothing.

Use a versioned release asset and an absolute binary path. A checkout build or
an unversioned PATH binary is not replacement evidence.

```sh
HWP_BIN=/absolute/path/to/hwp-v1.2.0/hwp
"$HWP_BIN" --version
"$HWP_BIN" skill export --install claude-code
"$HWP_BIN" skill export --install codex
```

The export installs a directory-shaped `hwp` skill tree. The native command
crosswalk, parity boundaries, and validation commands are maintained in the
versioned [editing recipes](https://github.com/STAIxBWLB/hwp-cli/blob/v1.2.0/skills/hwp/references/editing-recipes.md).
For Korean official-document guidance, use the exported
`hwp/references/korean-official-format.md` file. `gaejosik` references that
same released source.

## Existing local installations

This source retirement does not delete installed skill roots. Before removing a
stale `hwpx` directory, inspect its owner and provenance. It may be a user
installation, a symlink, or an older OTA snapshot rather than this bundle.

```sh
for root in \
  "${CODEX_HOME:-$HOME/.codex}/skills/hwpx" \
  "$HOME/.claude/skills/hwpx" \
  "$HOME/.maru/skills/hwpx"; do
  [ -e "$root" ] || continue
  ls -ld "$root"
  readlink "$root" || true
  [ -f "$root/upstream.json" ] && sed -n '1,80p' "$root/upstream.json"
done
```

Do not delete an installed root automatically. Confirm that it is owned by the
retired bundle using a symlink, installed manifest, or upstream marker, then
obtain explicit owner approval before removal. The supported Maru path is
`maru skills update --check` followed by `maru skills update --apply`; it
supersedes eligible OTA content without manually editing release assets.

## Rollback

If a post-retirement regression is found, keep the additive `hwp-cli` v0.12.1
release. Revert the skills retirement PR on `main` and let the normal release
workflow publish a new signed OTA revision. Do not edit or delete immutable
`skills-channel` assets in place.
