# Lumen desktop shell (Tauri) — SCAFFOLD

This wraps the existing Vue frontend as a native desktop **station** and supervises
two managed sidecars: the Express backend (`lumen-server`) and the media engine
(`lumen-media`). It is **written and reviewable but not compiled in the sandbox**
(no Rust/Tauri toolchain assumed).

## Why this doesn't break browser dev

`tauri.conf.json` sets `beforeDevCommand: "npm run dev"` and `devUrl:
http://localhost:5173` — Tauri dev just opens a native window onto the **same Vite
server** the browser already uses. `npm run dev` and browser development are
unchanged; the frontend feature-detects Tauri via `frontend/src/lib/tauri.ts` and
falls back to `window.open` when not packaged.

## To build it for real (on a machine with the toolchain)

1. Install Rust + the Tauri CLI (`cargo install tauri-cli`).
2. Bundle the Express backend and media sidecar into single binaries
   (`node-sea` or `pkg`, with the native `better-sqlite3`/`sharp` prebuilds) and
   place them in `src-tauri/binaries/` per the `externalBin` triples.
3. `cargo tauri dev` / `cargo tauri build`.

The Express composition root already honors `PORT`/`HOST`/`LUMEN_DATA_DIR`, so no
backend change is needed to run under Tauri — `sidecar.rs` just wires the env.

## Deliberately deferred (the §4.4 decision)

Express is NOT ported to Rust now — `auth.ts`/`db.ts`/`routes.ts`/`ws.ts` are
substantial and verified working. Bundle Node as a sidecar and revisit a Rust port
post-engine.
