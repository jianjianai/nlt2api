This project is based on [Nitro v3](https://nitro.build), [h3](https://h3.dev/), [Vite](https://vite.dev/) and [rolldown](https://rolldown.rs/).

Refer to `node_modules/nitro/dist/docs/README.md` when working on server (your knowledge about Nitro v3 is likely outdated!).

## Project Structure

`index.html` is the entry point at the project root. `app/` is the frontend (SPA/SSR) with `entry-client.ts` and `app.ts`. `server/` contains server-side code with supported subdirs (create as needed): `api/` (/api prefixed handlers), `routes/` (non-prefixed route handlers), `middleware/`, `plugins/`, `utils/`, `assets/`, and `tasks/`. `public/` holds static assets (copied, not bundled). Config files: `vite.config.ts` (loads `nitro/vite` plugin), `nitro.config.ts` (serverDir, routeRules, preset, etc.), `tsconfig.json` (extends nitro/tsconfig, `~/*` path alias).

## Conventions

- Path alias `~/*` (tsconfig), use explicit `.ts` extensions

## Release

发布流程见 [docs/release.md](docs/release.md)：只有推送 `v*` 标签才会触发打包发布（Docker 镜像 + GitHub Release），标签必须与 `package.json` 的 `version` 一致。

## Breezell project state

- Read `README.md` and `breezell/breezell.md` before major changes.
- Check `breezell/NEXT_GOAL.md` for the current handoff target.
- If the user says “继续”, first check `breezell/BREAKPOINT_CURRENT_TASK.md`; after loading it, delete it and continue from the recorded next action.
- Keep `breezell/` updated after meaningful work; it is local handoff state and must not be committed unless explicitly requested.
- Do not commit, push, submit pull requests, or modify remote state unless the user explicitly asks.

## Validation

- Run `pnpm test`, `pnpm typecheck`, and `pnpm build` when the changed boundary requires project validation.
- `pnpm probe:cli` is an end-to-end gate and requires the documented `NEURALWATT_PROBE_*` environment variables.
- Preserve the authentication and credential-handling boundaries documented in `README.md`; never expose account passwords, cookies, or API keys in client responses or logs.
