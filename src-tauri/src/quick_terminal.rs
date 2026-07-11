//! Quick Terminal: a Quake-style slide-in terminal panel on a dedicated,
//! non-draggable, non-resizable window anchored to a screen edge.
//!
//! The native window is never animated or resized by the OS; the slide
//! animation runs inside the webview (CSS transforms) and resizing happens
//! only through an in-panel drag handle that calls `resize_quick_terminal`.
//! See docs/quick-terminal-plan.md for the full design, including why this is
//! best-effort on Linux/Wayland (xdg-shell offers no toplevel positioning).
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

pub const WINDOW_LABEL: &str = "quick-terminal";

/// Minimum panel size in logical pixels for the resizable dimension.
const MIN_SIZE_LOGICAL: f64 = 200.0;

/// Slide animation length. The *native window* is animated (not the HTML):
/// the window carries a native backdrop-blur layer that fills its whole rect
/// the moment it's shown, so a CSS slide inside a static window would reveal
/// that blur rectangle instantly.
const SLIDE_DURATION_MS: u64 = 180;
const SLIDE_STEPS: u32 = 12;

/// Bumped to cancel any in-flight slide (new toggle, resize, disable).
static SLIDE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Bottom,
    Left,
    #[default]
    Right,
}

impl Edge {
    fn is_horizontal(self) -> bool {
        matches!(self, Edge::Left | Edge::Right)
    }
}

/// Per-edge user-chosen size (physical px of the resizable dimension).
/// `None` means the user never resized on that edge → use the default
/// (⅓ monitor width for left/right, ½ monitor height for top/bottom).
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
pub struct EdgeSizes {
    pub top: Option<u32>,
    pub bottom: Option<u32>,
    pub left: Option<u32>,
    pub right: Option<u32>,
}

impl EdgeSizes {
    fn get(&self, edge: Edge) -> Option<u32> {
        match edge {
            Edge::Top => self.top,
            Edge::Bottom => self.bottom,
            Edge::Left => self.left,
            Edge::Right => self.right,
        }
    }

    fn set(&mut self, edge: Edge, size: u32) {
        match edge {
            Edge::Top => self.top = Some(size),
            Edge::Bottom => self.bottom = Some(size),
            Edge::Left => self.left = Some(size),
            Edge::Right => self.right = Some(size),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct QuickTerminalSettings {
    pub enabled: bool,
    pub edge: Edge,
    pub sizes: EdgeSizes,
    /// Panel opacity, 0.3–1.0. The native window is fully transparent; this
    /// is applied by the frontend to the panel content.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
}

fn default_opacity() -> f64 {
    0.45
}

impl Default for QuickTerminalSettings {
    fn default() -> Self {
        QuickTerminalSettings {
            enabled: false,
            edge: Edge::default(),
            sizes: EdgeSizes::default(),
            opacity: default_opacity(),
        }
    }
}

/// Settings + environment info the settings UI needs in one round-trip.
#[derive(Serialize, Clone, Copy)]
pub struct QuickTerminalInfo {
    pub settings: QuickTerminalSettings,
    /// True on Linux/Wayland → the UI shows the reliability warning.
    pub wayland: bool,
}

#[derive(Serialize, Clone, Copy)]
struct ShowPayload {
    edge: Edge,
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("quick_terminal.json"))
}

pub fn load_settings(app: &AppHandle) -> QuickTerminalSettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &QuickTerminalSettings) {
    if let Some(path) = settings_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// The monitor the mouse cursor is currently on (Guake/iTerm convention),
/// falling back to the primary monitor.
///
/// Deliberately NOT `monitor_from_point`: `cursor_position()` returns
/// top-left-origin *physical* coordinates while `monitor_from_point` expects
/// *logical* ones (on macOS even bottom-left-origin), so combining them picks
/// a mouse-position-dependent wrong monitor on scaled displays. Monitor
/// `position()`/`size()` are physical, so containment is tested there.
fn target_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().unwrap_or_default();
    if let Ok(cursor) = app.cursor_position() {
        for monitor in &monitors {
            let pos = monitor.position();
            let size = monitor.size();
            if cursor.x >= pos.x as f64
                && cursor.x < (pos.x + size.width as i32) as f64
                && cursor.y >= pos.y as f64
                && cursor.y < (pos.y + size.height as i32) as f64
            {
                return Some(monitor.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

/// Applies edge-anchored geometry using *logical* coordinates derived from
/// the target monitor's scale factor. Physical values must not be handed to
/// `set_position`/`set_size` here: Tauri converts them with the *window's*
/// current scale factor, which is unreliable for a hidden (or
/// still-on-another-monitor) window and intermittently lands the panel
/// mid-screen at the wrong size. Logical coordinates are global across
/// monitors (same workaround as `open_settings_window_inner`).
fn apply_geometry(
    window: &tauri::WebviewWindow,
    edge: Edge,
    sizes: &EdgeSizes,
    monitor: &tauri::Monitor,
) {
    let (position, size) = compute_geometry(edge, sizes, monitor);
    let scale = monitor.scale_factor();
    let _ = window.set_size(tauri::LogicalSize::new(
        size.width as f64 / scale,
        size.height as f64 / scale,
    ));
    let _ = window.set_position(tauri::LogicalPosition::new(
        position.x as f64 / scale,
        position.y as f64 / scale,
    ));
}

/// Flush-against-the-edge geometry on the given monitor's work area, spanning
/// the full perpendicular dimension. All values are physical pixels.
fn compute_geometry(
    edge: Edge,
    sizes: &EdgeSizes,
    monitor: &tauri::Monitor,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let area = monitor.work_area();
    let min = (MIN_SIZE_LOGICAL * monitor.scale_factor()) as u32;

    let default_size = if edge.is_horizontal() {
        area.size.width / 3
    } else {
        area.size.height / 2
    };
    let max = if edge.is_horizontal() {
        area.size.width
    } else {
        area.size.height
    };
    let size = sizes.get(edge).unwrap_or(default_size).clamp(min, max);

    match edge {
        Edge::Top => (
            PhysicalPosition::new(area.position.x, area.position.y),
            PhysicalSize::new(area.size.width, size),
        ),
        Edge::Bottom => (
            PhysicalPosition::new(
                area.position.x,
                area.position.y + (area.size.height - size) as i32,
            ),
            PhysicalSize::new(area.size.width, size),
        ),
        Edge::Left => (
            PhysicalPosition::new(area.position.x, area.position.y),
            PhysicalSize::new(size, area.size.height),
        ),
        Edge::Right => (
            PhysicalPosition::new(
                area.position.x + (area.size.width - size) as i32,
                area.position.y,
            ),
            PhysicalSize::new(size, area.size.height),
        ),
    }
}

/// True if another monitor sits beyond the given edge of `monitor` — i.e.
/// the space the slide animation would travel through is NOT off-screen but
/// visible desktop on an extended display. Sliding there would show the
/// panel crossing onto the neighbouring monitor, so the animation must be
/// skipped in that case. Checked with a thin strip just past the edge,
/// in physical coordinates.
fn has_monitor_beyond(app: &AppHandle, monitor: &tauri::Monitor, edge: Edge) -> bool {
    let scale = monitor.scale_factor();
    let pos = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    // (x, y, w, h) strip 2px beyond the edge in logical coordinates, spanning the full edge length.
    let strip: (f64, f64, f64, f64) = match edge {
        Edge::Top => (pos.x, pos.y - 2.0, size.width, 2.0),
        Edge::Bottom => (pos.x, pos.y + size.height, size.width, 2.0),
        Edge::Left => (pos.x - 2.0, pos.y, 2.0, size.height),
        Edge::Right => (pos.x + size.width, pos.y, 2.0, size.height),
    };
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .filter(|other| other.position() != monitor.position())
        .any(|other| {
            let oscale = other.scale_factor();
            let opos = other.position().to_logical::<f64>(oscale);
            let osize = other.size().to_logical::<f64>(oscale);
            strip.0 < opos.x + osize.width
                && strip.0 + strip.2 > opos.x
                && strip.1 < opos.y + osize.height
                && strip.1 + strip.3 > opos.y
        })
}

/// On-screen (anchored) and off-screen (just past the edge) logical positions
/// plus the logical size, for the slide animation endpoints.
fn slide_endpoints(
    edge: Edge,
    sizes: &EdgeSizes,
    monitor: &tauri::Monitor,
) -> ((f64, f64), (f64, f64), (f64, f64)) {
    let (position, size) = compute_geometry(edge, sizes, monitor);
    let scale = monitor.scale_factor();
    let on = (position.x as f64 / scale, position.y as f64 / scale);
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let off = match edge {
        Edge::Top => (on.0, on.1 - h),
        Edge::Bottom => (on.0, on.1 + h),
        Edge::Left => (on.0 - w, on.1),
        Edge::Right => (on.0 + w, on.1),
    };
    (on, off, (w, h))
}

/// Ease-out slide of the native window between two logical positions,
/// optionally hiding it at the end. Cancelled if SLIDE_GENERATION moves on.
fn slide(window: tauri::WebviewWindow, from: (f64, f64), to: (f64, f64), hide_after: bool) {
    let generation = SLIDE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let step_delay = std::time::Duration::from_millis(SLIDE_DURATION_MS / SLIDE_STEPS as u64);
        for step in 1..=SLIDE_STEPS {
            if SLIDE_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let t = step as f64 / SLIDE_STEPS as f64;
            let eased = 1.0 - (1.0 - t).powi(3);
            let _ = window.set_position(tauri::LogicalPosition::new(
                from.0 + (to.0 - from.0) * eased,
                from.1 + (to.1 - from.1) * eased,
            ));
            tokio::time::sleep(step_delay).await;
        }
        if hide_after && SLIDE_GENERATION.load(Ordering::SeqCst) == generation {
            let _ = window.hide();
        }
    });
}

fn show_panel(app: &AppHandle, window: tauri::WebviewWindow, settings: &QuickTerminalSettings) {
    let Some(monitor) = target_monitor(app) else {
        return;
    };
    let animate = !has_monitor_beyond(app, &monitor, settings.edge);
    let (on, off, (w, h)) = slide_endpoints(settings.edge, &settings.sizes, &monitor);
    let start = if animate { off } else { on };
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    let _ = window.set_position(tauri::LogicalPosition::new(start.0, start.1));
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit(
        "quick-terminal:show",
        ShowPayload {
            edge: settings.edge,
        },
    );
    if animate {
        slide(window, off, on, false);
    } else {
        // A monitor adjoins the slide edge: cancel any in-flight slide and
        // appear in place instead of visibly crossing the neighbour display.
        SLIDE_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// Slide out from wherever the window actually is. The start position must
/// NOT be recomputed from a monitor: with extended displays the monitor
/// lookup (e.g. cursor fallback) can disagree with the monitor the panel is
/// really on, teleporting it there for the exit animation. Shifting the
/// window's real position by its own size clears the screen edge on any
/// monitor.
fn hide_panel(app: &AppHandle, window: tauri::WebviewWindow, settings: &QuickTerminalSettings) {
    // If another monitor adjoins the slide edge, don't animate — the panel
    // would visibly travel across the neighbouring display before hiding.
    let on_monitor = window.current_monitor().ok().flatten();
    if let Some(monitor) = &on_monitor {
        if has_monitor_beyond(app, monitor, settings.edge) {
            SLIDE_GENERATION.fetch_add(1, Ordering::SeqCst);
            let _ = window.hide();
            return;
        }
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
        let _ = window.hide();
        return;
    };
    let on = (position.x as f64 / scale, position.y as f64 / scale);
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let off = match settings.edge {
        Edge::Top => (on.0, on.1 - h),
        Edge::Bottom => (on.0, on.1 + h),
        Edge::Left => (on.0 - w, on.1),
        Edge::Right => (on.0 + w, on.1),
    };
    slide(window, on, off, true);
}

/// Toggle entry point, called by the global hotkey and by commands.
/// The native window slides in/out; the frontend only mounts the terminal.
pub fn toggle(app: &AppHandle) {
    let settings = load_settings(app);
    if !settings.enabled {
        return;
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        hide_panel(app, window, &settings);
    } else {
        // A panel whose webview died while loading hidden would slide in as
        // an empty transparent shell (i.e. nothing visible at all). Reload it
        // and defer this toggle through the existing PendingToggle handshake:
        // the fresh page calls quick_terminal_frontend_ready once its event
        // listeners are mounted, which performs the slide-in.
        if crate::revive_webview_if_stuck(&window) {
            app.state::<PendingToggle>()
                .0
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        show_panel(app, window, &settings);
    }
}

#[tauri::command]
pub fn toggle_quick_terminal(app: AppHandle) {
    toggle(&app);
}

/// Set when the app was cold-launched by the hotkey daemon with
/// `--hotkey=quick-terminal`: the panel can only slide in after its webview
/// has mounted and subscribed to the show/hide events, so the toggle is
/// deferred until the frontend reports in.
#[derive(Default)]
pub struct PendingToggle(pub std::sync::atomic::AtomicBool);

#[tauri::command]
pub fn quick_terminal_frontend_ready(app: AppHandle) {
    let pending = app.state::<PendingToggle>();
    if pending.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
        toggle(&app);
    }
}

/// Slide-out + hide; called by the panel's close (×) button.
#[tauri::command]
pub fn hide_quick_terminal(app: AppHandle) {
    let settings = load_settings(&app);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            hide_panel(&app, window, &settings);
        }
    }
}

/// Live-resizes the panel while the in-panel handle is dragged. `size` is the
/// new value of the resizable dimension in physical pixels. `commit` persists
/// the size for the current edge (sent on pointer-up).
#[tauri::command]
pub fn resize_quick_terminal(app: AppHandle, size: u32, commit: bool) -> Result<(), String> {
    let mut settings = load_settings(&app);
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("Quick Terminal window not found".to_string());
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| target_monitor(&app))
        .ok_or("No monitor found")?;

    // Cancel any in-flight slide so it doesn't fight the drag.
    SLIDE_GENERATION.fetch_add(1, Ordering::SeqCst);

    let mut sizes = settings.sizes;
    sizes.set(settings.edge, size);
    // compute_geometry clamps to [min, work area] and re-anchors to the edge,
    // so the panel only ever grows/shrinks away from its screen edge.
    let (_, clamped_size) = compute_geometry(settings.edge, &sizes, &monitor);
    apply_geometry(&window, settings.edge, &sizes, &monitor);

    if commit {
        let committed = if settings.edge.is_horizontal() {
            clamped_size.width
        } else {
            clamped_size.height
        };
        settings.sizes.set(settings.edge, committed);
        save_settings(&app, &settings);
    }
    Ok(())
}

#[tauri::command]
pub fn get_quick_terminal_info(app: AppHandle) -> QuickTerminalInfo {
    QuickTerminalInfo {
        settings: load_settings(&app),
        wayland: crate::global_hotkey::is_wayland(),
    }
}

#[tauri::command]
pub fn set_quick_terminal_edge(app: AppHandle, edge: Edge) {
    let mut settings = load_settings(&app);
    settings.edge = edge;
    save_settings(&app, &settings);
    // If the panel is currently visible, snap it to the new edge immediately.
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            if let Some(monitor) = window.current_monitor().ok().flatten() {
                apply_geometry(&window, settings.edge, &settings.sizes, &monitor);
                let _ = app.emit(
                    "quick-terminal:show",
                    ShowPayload {
                        edge: settings.edge,
                    },
                );
            }
        }
    }
}

#[tauri::command]
pub fn set_quick_terminal_opacity(app: AppHandle, opacity: f64) {
    let mut settings = load_settings(&app);
    settings.opacity = opacity.clamp(0.3, 1.0);
    save_settings(&app, &settings);
    // Live-update the panel window if it exists (visible or not).
    let _ = app.emit("quick-terminal:opacity-changed", settings.opacity);
}

#[tauri::command]
pub fn set_quick_terminal_enabled(app: AppHandle, enabled: bool) {
    let mut settings = load_settings(&app);
    settings.enabled = enabled;
    save_settings(&app, &settings);
    if !enabled {
        // Cancel any slide and hide immediately — the feature was turned off.
        SLIDE_GENERATION.fetch_add(1, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.hide();
        }
    }
}
