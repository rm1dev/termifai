//! Linux/Wayland backend: global shortcuts via the XDG desktop portal
//! (`org.freedesktop.portal.GlobalShortcuts`), owned by the daemon so the
//! compositor-side grabs survive the main app quitting.
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use futures::StreamExt;
use std::collections::HashMap;

type Session = ashpd::desktop::Session<'static, GlobalShortcuts<'static>>;

pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");
    runtime.block_on(async {
        if let Err(e) = run_inner().await {
            crate::log_line(&format!("portal backend error: {e}"));
        }
    });
}

async fn run_inner() -> Result<(), ashpd::Error> {
    let proxy = GlobalShortcuts::new().await?;

    // Activation events for every session we own; the shortcut id is the
    // action name, which is all `launch_app` needs.
    let mut activated = proxy.receive_activated().await?;
    tokio::spawn(async move {
        while let Some(activation) = activated.next().await {
            crate::launch_app(activation.shortcut_id());
        }
    });

    // action → (accelerator, session). Sessions are kept alive for as long as
    // the action stays enabled with the same accelerator.
    let mut bound: HashMap<String, (String, Session)> = HashMap::new();

    loop {
        let desired = crate::load_enabled_actions();
        if desired.is_empty() {
            return Ok(()); // all disabled → daemon exits
        }

        let stale: Vec<String> = bound
            .keys()
            .filter(|action| desired.get(*action) != bound.get(*action).map(|(a, _)| a))
            .cloned()
            .collect();
        for action in stale {
            if let Some((_, session)) = bound.remove(&action) {
                let _ = session.close().await;
            }
        }

        for (action, accel) in &desired {
            if bound.contains_key(action) {
                continue;
            }
            match bind(&proxy, action, accel).await {
                Ok(session) => {
                    bound.insert(action.clone(), (accel.clone(), session));
                }
                Err(e) => crate::log_line(&format!("failed to bind '{action}': {e}")),
            }
        }

        tokio::time::sleep(crate::SYNC_INTERVAL).await;
    }
}

async fn bind(
    proxy: &GlobalShortcuts<'static>,
    action: &str,
    accelerator: &str,
) -> Result<Session, ashpd::Error> {
    let session = proxy.create_session().await?;
    let description = match action {
        "quick-terminal" => "Toggle Termifai Quick Terminal",
        _ => "Toggle Termifai window",
    };
    let trigger = accelerator_to_portal_trigger(accelerator);
    let shortcut = NewShortcut::new(action, description).preferred_trigger(trigger.as_str());
    let request = proxy
        .bind_shortcuts(&session, &[shortcut], &ashpd::WindowIdentifier::default())
        .await?;
    request.response()?;
    Ok(session)
}

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
