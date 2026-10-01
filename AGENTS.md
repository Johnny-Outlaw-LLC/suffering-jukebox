# Repository workflow

This repository root is the canonical checkout. Start every session here and verify it before editing:

```sh
git rev-parse --show-toplevel
git branch --show-current
git status --short
```

- Use `main` as the current integration baseline unless the user explicitly names another branch.
- Do not treat `recovery/*` or `sj-snapshot` branches as active development branches. They preserve older unsaved work for selective recovery.
- Do not create worktrees inside this repository. If isolation is explicitly needed, put the worktree in a sibling directory and record why it exists.
- Before copying web assets into the native app, verify the feature in `public/` and use the scripts in `native/package.json`. Do not replace `public/` from a generated native bundle.
- Keep `.env.local` only at the repository root; it is ignored by Git.
- Never delete recovery branches or the sibling recovery archive without explicit user approval.

