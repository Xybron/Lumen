// Sidecar lifecycle (SCAFFOLD). Spawns and supervises the Express backend and the
// media engine as managed external binaries (declared in tauri.conf.json
// `externalBin`). Restart-with-backoff mirrors the backoff arrays used elsewhere
// in the codebase (ws.ts / vps-bridge.ts) for consistency.

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

const BACKOFF_MS: [u64; 5] = [500, 1000, 2000, 5000, 10000];

pub fn spawn_sidecars(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Express backend — owns content.json + lumen.db + the WS relay. Honors
    // PORT/HOST/LUMEN_DATA_DIR with no code change.
    spawn_one(
        app,
        "lumen-server",
        vec![
            ("PORT", "3000".into()),
            ("HOST", "127.0.0.1".into()),
            ("LUMEN_DATA_DIR", data_dir.clone()),
        ],
    );

    // Media engine — WHIP ingest + ffmpeg/MediaMTX egress. Express discovers it
    // via LUMEN_MEDIA_CTRL.
    spawn_one(
        app,
        "lumen-media",
        vec![("LUMEN_MEDIA_PORT", "7401".into())],
    );

    Ok(())
}

fn spawn_one(app: &AppHandle, name: &str, env: Vec<(&str, String)>) {
    let app = app.clone();
    let name = name.to_string();
    tauri::async_runtime::spawn(async move {
        let mut attempt = 0usize;
        loop {
            let cmd = app
                .shell()
                .sidecar(&name)
                .expect("sidecar binary missing")
                .envs(env.iter().map(|(k, v)| (k.to_string(), v.clone())));
            match cmd.spawn() {
                Ok((_rx, _child)) => {
                    attempt = 0;
                    // In a full implementation we'd await the child and only loop on exit.
                    break;
                }
                Err(_) => {
                    let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    });
}

pub fn shutdown(_app: &AppHandle) {
    // tauri-plugin-shell terminates managed sidecars on drop; explicit SIGTERM →
    // SIGKILL escalation goes here in the full implementation.
}
