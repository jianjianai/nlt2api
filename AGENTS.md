# AGENTS.md

- Read `README.md` and `breezell/breezell.md` before major changes.
- Check `breezell/NEXT_GOAL.md` for the current handoff target.
- If the user says "继续", first check for `breezell/BREAKPOINT_CURRENT_TASK.md`; if present, load and consume it before continuing.
- Keep changing execution state in `breezell/`; do not commit that directory unless explicitly requested.
- Preserve the OpenAI-compatible API contract documented in `README.md` and `OPENAI_CHAT_COMPATIBILITY.md` unless the task explicitly changes it.
- Never commit account passwords, cookies, proxy keys, `.data/`, or local environment files.
- Do not push, open pull requests, or modify remote state unless explicitly requested.
- Use `pnpm test` as the default focused validation; use `pnpm run build` when the changed boundary requires a production build check.
