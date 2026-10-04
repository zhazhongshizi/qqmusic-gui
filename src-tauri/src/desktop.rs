use serde::Deserialize;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State,
};

use crate::{player::PlayerState, AppState, PublicError};

const TRAY_ID: &str = "qqmusic-main-tray";
const TRAY_MENU_LABEL: &str = "tray-menu";
const TRAY_MENU_SHOWN_EVENT: &str = "tray-menu://shown";
const TRAY_MENU_HIDDEN_EVENT: &str = "tray-menu://hidden";
pub(crate) const MAIN_WINDOW_VISIBLE_EVENT: &str = "qqmusic:main-window-visible";
const TRAY_MENU_LOGICAL_WIDTH: f64 = 356.0;
const TRAY_MENU_LOGICAL_HEIGHT: f64 = 306.0;
const TRAY_MENU_GAP: i32 = 8;
const TRAY_MENU_SAFE_INSET: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrayMenuAction {
    TogglePlayback,
    Previous,
    Next,
    ShowMain,
    Hide,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PixelRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl PixelRect {
    fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn inset(self, inset: u32) -> Self {
        let doubled = inset.saturating_mul(2);
        Self {
            x: self
                .x
                .saturating_add(i32::try_from(inset).unwrap_or(i32::MAX)),
            y: self
                .y
                .saturating_add(i32::try_from(inset).unwrap_or(i32::MAX)),
            width: self.width.saturating_sub(doubled),
            height: self.height.saturating_sub(doubled),
        }
    }
}

pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .show_menu_on_left_click(false)
        .tooltip("QQ Music GUI")
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                position,
                rect,
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } => show_tray_menu(tray.app_handle(), position, rect),
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match (window.label(), event) {
        ("main", tauri::WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            hide_main_window(window);
        }
        (TRAY_MENU_LABEL, tauri::WindowEvent::Focused(false)) => {
            hide_tray_menu(window.app_handle());
        }
        (TRAY_MENU_LABEL, tauri::WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            hide_tray_menu(window.app_handle());
        }
        _ => {}
    }
}

pub(crate) fn should_prevent_exit(code: Option<i32>) -> bool {
    code.is_none()
}

#[tauri::command]
pub(crate) async fn tray_menu_action(
    action: TrayMenuAction,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), PublicError> {
    match action {
        TrayMenuAction::ShowMain => {
            show_main_window(&app);
            hide_tray_menu(&app);
            Ok(())
        }
        TrayMenuAction::Hide => {
            hide_tray_menu(&app);
            Ok(())
        }
        TrayMenuAction::Quit => {
            app.exit(0);
            Ok(())
        }
        TrayMenuAction::TogglePlayback | TrayMenuAction::Previous | TrayMenuAction::Next => {
            let session = state
                .playback_session
                .clone()
                .ok_or_else(crate::playback_unavailable)?;
            crate::run_session_blocking(move || match action {
                TrayMenuAction::TogglePlayback => {
                    if should_pause_for_toggle(session.snapshot().player.state) {
                        session.pause().map(|_| ())
                    } else {
                        session.play().map(|_| ())
                    }
                }
                TrayMenuAction::Previous => session.previous().map(|_| ()),
                TrayMenuAction::Next => session.next().map(|_| ()),
                TrayMenuAction::ShowMain | TrayMenuAction::Hide | TrayMenuAction::Quit => {
                    unreachable!("window actions are handled before playback dispatch")
                }
            })
            .await
        }
    }
}

fn should_pause_for_toggle(state: PlayerState) -> bool {
    matches!(state, PlayerState::Playing | PlayerState::Loading)
}

fn show_tray_menu(app: &AppHandle, cursor: PhysicalPosition<f64>, tray_rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        return;
    };

    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let scale_factor = monitor
        .as_ref()
        .map_or(1.0, tauri::window::Monitor::scale_factor);
    let popup_size = window
        .outer_size()
        .ok()
        .filter(|size| size.width > 0 && size.height > 0)
        .unwrap_or_else(|| fallback_popup_size(scale_factor));
    let tray_position = tray_rect.position.to_physical::<i32>(scale_factor);
    let tray_size = tray_rect.size.to_physical::<u32>(scale_factor);
    let tray = PixelRect {
        x: tray_position.x,
        y: tray_position.y,
        width: tray_size.width,
        height: tray_size.height,
    };

    let position = monitor.map_or_else(
        || fallback_position(cursor, popup_size),
        |monitor| {
            let work_area = monitor.work_area();
            place_tray_menu(
                tray,
                popup_size,
                PixelRect {
                    x: work_area.position.x,
                    y: work_area.position.y,
                    width: work_area.size.width,
                    height: work_area.size.height,
                },
            )
        },
    );

    if window.set_position(position).is_err() {
        return;
    }
    if window.show().is_err() {
        return;
    }
    let _ = window.set_focus();
    let _ = app.emit_to(TRAY_MENU_LABEL, TRAY_MENU_SHOWN_EVENT, ());
}

fn hide_tray_menu(app: &AppHandle) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        return;
    };
    let _ = app.emit_to(TRAY_MENU_LABEL, TRAY_MENU_HIDDEN_EVENT, ());
    let _ = window.hide();
}

fn fallback_popup_size(scale_factor: f64) -> PhysicalSize<u32> {
    PhysicalSize::new(
        (TRAY_MENU_LOGICAL_WIDTH * scale_factor).round().max(1.0) as u32,
        (TRAY_MENU_LOGICAL_HEIGHT * scale_factor).round().max(1.0) as u32,
    )
}

fn fallback_position(
    cursor: PhysicalPosition<f64>,
    popup_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let x = cursor.x.round() as i64 - i64::from(popup_size.width);
    let y = cursor.y.round() as i64 - i64::from(popup_size.height) - i64::from(TRAY_MENU_GAP);
    PhysicalPosition::new(saturating_i32(x), saturating_i32(y))
}

fn place_tray_menu(
    tray: PixelRect,
    popup: PhysicalSize<u32>,
    work_area: PixelRect,
) -> PhysicalPosition<i32> {
    let safe = work_area.inset(TRAY_MENU_SAFE_INSET);
    let tray_left = i64::from(tray.x);
    let tray_top = i64::from(tray.y);
    let tray_right = tray.right();
    let tray_bottom = tray.bottom();
    let work_left = i64::from(work_area.x);
    let work_right = work_area.right();
    let popup_width = i64::from(popup.width);
    let popup_height = i64::from(popup.height);
    let gap = i64::from(TRAY_MENU_GAP);

    let (preferred_x, preferred_y) = if tray_left >= work_right {
        (tray_left - gap - popup_width, tray_bottom - popup_height)
    } else if tray_right <= work_left {
        (tray_right + gap, tray_bottom - popup_height)
    } else {
        let above = tray_top - gap - popup_height;
        let below = tray_bottom + gap;
        let safe_top = i64::from(safe.y);
        let safe_bottom = safe.bottom();
        let above_fits = above >= safe_top && above + popup_height <= safe_bottom;
        let below_fits = below >= safe_top && below + popup_height <= safe_bottom;
        let y = if above_fits {
            above
        } else if below_fits {
            below
        } else {
            above
        };
        (tray_right - popup_width, y)
    };

    PhysicalPosition::new(
        clamp_axis(preferred_x, safe.x, safe.width, popup.width),
        clamp_axis(preferred_y, safe.y, safe.height, popup.height),
    )
}

fn clamp_axis(preferred: i64, start: i32, length: u32, item_length: u32) -> i32 {
    let start = i64::from(start);
    let end = start + i64::from(length);
    let max_start = end - i64::from(item_length);
    if max_start <= start {
        saturating_i32(start)
    } else {
        saturating_i32(preferred.clamp(start, max_start))
    }
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show_main_window_with(
            || window.show().is_ok(),
            || window.unminimize().is_ok(),
            |event, visible| window.emit(event, visible).is_ok(),
            || window.set_focus().is_ok(),
        );
    }
}

fn hide_main_window(window: &tauri::Window) {
    hide_main_window_with(
        |event, visible| window.emit(event, visible).is_ok(),
        || window.hide().is_ok(),
    );
}

/// Applies the close-to-tray transition in a deterministic order.
///
/// The callbacks keep the ordering independently testable without requiring a
/// live WebView window. A failed visibility notification must not prevent the
/// native hide operation from being attempted.
fn hide_main_window_with<E, H>(mut emit: E, mut hide: H)
where
    E: FnMut(&str, bool) -> bool,
    H: FnMut() -> bool,
{
    let _ = emit(MAIN_WINDOW_VISIBLE_EVENT, false);
    let _ = hide();
}

/// Applies the restore transition in a deterministic order.
///
/// Visibility is published only after both native restore operations succeed;
/// focus remains best-effort and is attempted after the notification even when
/// the notification itself fails.
fn show_main_window_with<S, U, E, F>(mut show: S, mut unminimize: U, mut emit: E, mut focus: F)
where
    S: FnMut() -> bool,
    U: FnMut() -> bool,
    E: FnMut(&str, bool) -> bool,
    F: FnMut() -> bool,
{
    let shown = show();
    let unminimized = unminimize();
    if shown && unminimized {
        let _ = emit(MAIN_WINDOW_VISIBLE_EVENT, true);
    }
    let _ = focus();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> PixelRect {
        PixelRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn tray_menu_accepts_only_the_fixed_action_allowlist() {
        for action in [
            "togglePlayback",
            "previous",
            "next",
            "showMain",
            "hide",
            "quit",
        ] {
            assert!(serde_json::from_str::<TrayMenuAction>(&format!("\"{action}\"")).is_ok());
        }
        assert!(serde_json::from_str::<TrayMenuAction>("\"shell\"").is_err());
        assert!(serde_json::from_str::<TrayMenuAction>("\"https://sentinel.invalid\"").is_err());
        assert!(serde_json::from_str::<TrayMenuAction>("\"C:\\\\Windows\\\\System32\"").is_err());
    }

    #[test]
    fn bottom_taskbar_places_menu_above_the_icon() {
        let position = place_tray_menu(
            rect(1880, 1040, 24, 24),
            PhysicalSize::new(356, 306),
            rect(0, 0, 1920, 1040),
        );
        assert_eq!(position, PhysicalPosition::new(1548, 726));
    }

    #[test]
    fn top_taskbar_places_menu_below_the_icon() {
        let position = place_tray_menu(
            rect(1880, 8, 24, 24),
            PhysicalSize::new(356, 306),
            rect(0, 40, 1920, 1040),
        );
        assert_eq!(position, PhysicalPosition::new(1548, 48));
    }

    #[test]
    fn side_taskbars_place_menu_inside_the_work_area() {
        let right = place_tray_menu(
            rect(1880, 1000, 24, 24),
            PhysicalSize::new(356, 306),
            rect(0, 0, 1880, 1080),
        );
        assert_eq!(right, PhysicalPosition::new(1516, 718));

        let left = place_tray_menu(
            rect(8, 1000, 24, 24),
            PhysicalSize::new(356, 306),
            rect(40, 0, 1880, 1080),
        );
        assert_eq!(left, PhysicalPosition::new(48, 718));
    }

    #[test]
    fn negative_coordinate_monitor_and_scaled_popup_are_preserved() {
        let position = place_tray_menu(
            rect(-40, 1400, 30, 30),
            PhysicalSize::new(534, 459),
            rect(-2560, 0, 2560, 1400),
        );
        assert_eq!(position, PhysicalPosition::new(-544, 933));
    }

    #[test]
    fn oversized_popup_clamps_to_safe_origin() {
        let position = place_tray_menu(
            rect(90, 90, 16, 16),
            PhysicalSize::new(500, 400),
            rect(-100, -50, 200, 150),
        );
        assert_eq!(position, PhysicalPosition::new(-92, -42));
    }

    #[test]
    fn toggle_pauses_playing_and_loading_only() {
        assert!(should_pause_for_toggle(PlayerState::Playing));
        assert!(should_pause_for_toggle(PlayerState::Loading));
        assert!(!should_pause_for_toggle(PlayerState::Paused));
        assert!(!should_pause_for_toggle(PlayerState::Idle));
        assert!(!should_pause_for_toggle(PlayerState::Ended));
        assert!(!should_pause_for_toggle(PlayerState::Failed));
    }

    #[test]
    fn implicit_last_window_exit_is_prevented_but_explicit_quit_is_allowed() {
        assert!(should_prevent_exit(None));
        assert!(!should_prevent_exit(Some(0)));
        assert!(!should_prevent_exit(Some(1)));
    }

    #[test]
    fn close_to_tray_publishes_false_before_hiding() {
        let actions = RefCell::new(Vec::new());
        hide_main_window_with(
            |event, visible| {
                actions.borrow_mut().push((event.to_owned(), visible));
                true
            },
            || {
                actions.borrow_mut().push(("hide".to_owned(), false));
                true
            },
        );

        assert_eq!(
            *actions.borrow(),
            vec![
                (MAIN_WINDOW_VISIBLE_EVENT.to_owned(), false),
                ("hide".to_owned(), false)
            ]
        );
    }

    #[test]
    fn close_to_tray_still_hides_when_visibility_publish_fails() {
        let mut hide_attempted = false;
        hide_main_window_with(
            |_event, _visible| false,
            || {
                hide_attempted = true;
                true
            },
        );
        assert!(hide_attempted);
    }

    #[test]
    fn restore_publishes_true_before_focus_with_strict_bool_payload() {
        let actions = RefCell::new(Vec::new());
        show_main_window_with(
            || {
                actions.borrow_mut().push("show");
                true
            },
            || {
                actions.borrow_mut().push("unminimize");
                true
            },
            |event, visible| {
                assert_eq!(event, MAIN_WINDOW_VISIBLE_EVENT);
                assert!(visible);
                actions.borrow_mut().push("visible");
                true
            },
            || {
                actions.borrow_mut().push("focus");
                true
            },
        );
        assert_eq!(
            *actions.borrow(),
            vec!["show", "unminimize", "visible", "focus"]
        );
    }

    #[test]
    fn restore_does_not_publish_visible_after_native_restore_failure() {
        let mut visibility_published = false;
        let mut focus_attempted = false;
        show_main_window_with(
            || true,
            || false,
            |_event, _visible| {
                visibility_published = true;
                true
            },
            || {
                focus_attempted = true;
                true
            },
        );
        assert!(!visibility_published);
        assert!(focus_attempted);
    }
}
