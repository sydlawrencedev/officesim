# Upstream: pixel-agents

OfficeSim's office engine started as a copy of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) (MIT, © Pablo De Lucca). It was copied, not forked, so the two repos share no git history. This file records where the copy came from, so we can keep pulling upstream changes in.

| Upstream | Here |
| --- | --- |
| `webview-ui/src/office/` | `src/office/` |
| `webview-ui/src/constants.ts` | `src/constants.ts` |
| `core/src/paletteUtils.ts` | `src/core/paletteUtils.ts` |
| `webview-ui/public/assets/` | `public/assets/` |

- Copied from: `ef9fe9e` (2026-04-15, feat: add Agent Teams visualization)
- Synced to: `3537e14` (2026-08-15, chore: bump to v1.4.1 (#392))

## Syncing

```bash
scripts/sync-upstream-office.sh
```

Assets aren't merged: copy new upstream pets, carpets or characters into `public/assets/` by hand. `scripts/assetIndex.mjs` picks them up.

The script adds the `pixel-agents` remote if it's missing and three-way merges every shared file, using the last synced commit as the base. It then lists the upstream-only files and updates "Synced to" above. Resolve any conflict markers, run `pnpm typecheck && pnpm build`, and commit.

Upstream pieces we deliberately leave out:
- the layout editor (`editor/`)
- the VS Code canvas and overlays (`components/`; `src/ui/PixelOfficeCanvas.tsx` replaces them)
- `existingAgents.ts`
- `layout/exportLayout.ts`
- ghosts and context gauges: every Paperclip agent is headless, and Paperclip doesn't give us transcripts
