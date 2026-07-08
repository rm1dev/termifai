//! Wayland backend: binds a global shortcut via the XDG desktop portal
//! `org.freedesktop.portal.GlobalShortcuts` interface using `ashpd`.
//!
//! This path only runs on Linux when a Wayland session is detected
//! (see `super::is_wayland`). Unlike the `tauri-plugin-global-shortcut` path,
//! the compositor — not this process — owns the actual key grab, and it will
//! show the user a one-time system confirmation dialog the moment
//! `bind_shortcuts` is called. That's expected and desired: it only fires
//! because the user just clicked "Enable" in Settings.
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures::StreamExt;
use tauri::AppHandle;

const SHORTCUT_ID: &str = "toggle-window";

/// Keeps the portal session + its background listener task alive for as long
/// as the hotkey is enabled. Dropping/aborting the task and letting the
/// `Session` go out of scope releases the compositor-side grab.
pub struct PortalSession {
    _session: ashpd::desktop::Session<'static, GlobalShortcuts<'static>>,
    listener: tokio::task::JoinHandle<()>,
}

pub fn close(session: PortalSession) {
    session.listener.abort();
    // `_session` drops here, closing the D-Bus session.
}

/// Binds `accelerator` (best-effort translated to portal trigger syntax) and
/// starts listening for `Activated` signals, toggling the main window on each.
/// Returns the session (kept alive by the caller) and the accelerator string
/// actually reported back — the portal/compositor has final say over the
/// bound key combo, which may differ from our preferred trigger.
pub async fn bind(
    app: AppHandle,
    accelerator: String,
) -> Result<(PortalSession, String), ashpd::Error> {
    let proxy = GlobalShortcuts::new().await?;
    let session = proxy.create_session().await?;

    let trigger = accelerator_to_portal_trigger(&accelerator);
    let shortcut =
        NewShortcut::new(SHORTCUT_ID, "Toggle Termifai window").preferred_trigger(trigger.as_str());

    let request = proxy.bind_shortcuts(&session, &[shortcut], None).await?;
    let bound = request.response()?;

    let effective_accelerator = bound
        .shortcuts()
        .iter()
        .find(|s| s.id() == SHORTCUT_ID)
        .and_then(|s| s.trigger_description().map(|d| d.to_string()))
        .unwrap_or(accelerator);

    let mut activated = proxy.receive_activated().await?;
    let app_for_task = app.clone();
    let listener = tauri::async_runtime::spawn(async move {
        while activated.next().await.is_some() {
            super::toggle_main_window(&app_for_task);
        }
    });

    Ok((
        PortalSession {
            _session: session,
            listener,
        },
        effective_accelerator,
    ))
}

/// Translates our Tauri accelerator syntax ("CmdOrCtrl+Shift+Space") into the
/// portal's expected trigger syntax (space-separated modifiers + key, e.g.
/// "CTRL SHIFT space"). This is only a *preferred* trigger — the compositor
/// may present its own binding UI and choose differently.
fn accelerator_to_portal_trigger(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "ctrl" | "control" => "CTRL".to_string(),
            "alt" | "option" => "ALT".to_string(),
            "shift" => "SHIFT".to_string(),
            "super" | "cmd" | "meta" => "LOGO".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}
