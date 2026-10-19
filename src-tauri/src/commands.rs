// Tauri commands invoked from the Vue frontend via the `lib/tauri.ts` shim
// (SCAFFOLD). The browser falls back to window.open when these aren't present.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn projection_window(app: AppHandle, label: &str, path: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("http://127.0.0.1:3000{path}");
    WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::External(url.parse().map_err(|_| "bad url")?),
    )
    .title("Lumen — Live View")
    .decorations(false)
    .fullscreen(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Open a channel's projection output as a borderless native window. The operator
// drags it to the projector monitor and it shows /live/<channelId> from the local
// backend — reusing LiveView.vue unchanged.
#[tauri::command]
pub fn open_projection_window(app: AppHandle, channel_id: String) -> Result<(), String> {
    let label = format!("projection-{channel_id}");
    projection_window(app, &label, &format!("/live/{channel_id}"))
}

// Program is an authenticated operator monitor. This opens the existing route;
// the production hub continues to enforce operator access to the Program bus.
#[tauri::command]
pub fn open_studio_projection_window(app: AppHandle) -> Result<(), String> {
    projection_window(app, "projection-studio-program", "/studio/output/program")
}
