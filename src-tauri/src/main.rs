// Lumen desktop shell (Tauri) — SCAFFOLD, not compiled in the sandbox.
//
// Responsibilities:
//  1. Spawn + supervise the Express backend sidecar (lumen-server) pointed at the
//     OS app-data dir, and the media engine sidecar (lumen-media). The Express
//     composition root already honors PORT/HOST/LUMEN_DATA_DIR, so NO backend
//     change is needed to run under Tauri.
//  2. Wait for the backend to be healthy before showing the window.
//  3. Provide native projection windows (open_projection_window) so outputs are
//     borderless windows on the projector monitor instead of browser tabs.
//  4. Kill both sidecars on app exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod sidecar;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Spawn the managed sidecars (Express + media engine) and wait for health.
            sidecar::spawn_sidecars(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_projection_window,
            commands::open_studio_projection_window
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Graceful shutdown: stop the sidecars before the app exits.
                sidecar::shutdown(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lumen");
}
