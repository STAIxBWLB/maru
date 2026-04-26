# Anchor

Anchor is a local-first desktop app for RISE/Anchor project documents. It combines a plain-file vault, type-aware knowledge notes, document versioning, and Korean administrative writing helpers.

## Development

```bash
pnpm install
pnpm dev
pnpm tauri:dev
```

The browser dev server includes a mock data adapter. The Tauri app uses real filesystem commands for vault scanning, document reads/writes, and version creation.

## MVP Scope

- Local markdown/HTML vault as the source of truth
- Document, person, project, task, template, and reference note types
- Version snapshots under `.anchor/versions`
- Local AI-draft adapter for report, minutes, summary, KPI, and budget writing flows
- Sample Anchor vault for first-run exploration
