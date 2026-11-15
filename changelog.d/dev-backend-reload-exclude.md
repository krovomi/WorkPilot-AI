---
section: 🐛 Corrections
---

- **`pnpm dev` starts the backend again when `apps/backend` has no virtualenv of its own.** The
  launcher passed uvicorn an absolute `--reload-exclude` for `apps/backend/.venv` even when that
  folder did not exist (venv at the repo root), and uvicorn stopped with « Non-relative patterns
  are unsupported ». The exclude is now passed only when the folder is there, in `pnpm dev` and in
  the backend the app starts in development.
