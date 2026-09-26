use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime,
};

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
#[cfg(not(target_os = "macos"))]
use tauri::menu::HELP_SUBMENU_ID;

const CHECK_FOR_UPDATES_MENU_ID: &str = "app.check_for_updates";
const CHECK_FOR_UPDATES_EVENT: &str = "maru://check-for-updates";
const MENU_COMMAND_EVENT: &str = "maru://menu-command";
// D-03: the id the macOS App-submenu Quit item emits, routed through the
// existing generic MENU_COMMAND_EVENT path (handle_menu_event below is
// unchanged) into App.tsx's runMenuCommand -> requestWindowClose(), the same
// guard the red close button reaches. macOS-only: Windows/Linux keep the
// platform-native Quit affordance untouched.
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "app.quit";

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // D-03/A1: replace tauri's predefined native Quit item (the predefined
    // menu item that calls NSApplication terminate: and bypasses the webview
    // entirely — research Pitfall 2) with a Maru-owned command item before
    // the Maru menus and Check-for-Updates item are inserted, so Check for
    // Updates still lands at index 1 of the (now Maru-built) App submenu.
    #[cfg(target_os = "macos")]
    {
        let _ = menu.remove_at(0)?;
        let app_submenu = build_macos_app_submenu(app)?;
        menu.insert(&app_submenu, 0)?;
    }
    let check_for_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates...",
        true,
        None::<&str>,
    )?;

    install_maru_menus(app, &menu)?;
    insert_check_for_updates_item(app, &menu, &check_for_updates)?;
    Ok(menu)
}

/// Reproduces tauri 2.10.3's `Menu::default` macOS App submenu item-for-item
/// (About, Services, Hide, Hide Others — see
/// tauri-2.10.3/src/menu/menu.rs:186-204) but ends with a Maru `command_item`
/// instead of the predefined native quit item, so Cmd+Q reaches the webview.
#[cfg(target_os = "macos")]
fn build_macos_app_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let quit = command_item(app, QUIT_MENU_ID, "Quit Maru", Some("CmdOrCtrl+Q"))?;
    Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn install_maru_menus<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    remove_default_submenus(menu, &["File", "Edit", "View", "Window"])?;
    let insert_at = maru_menu_insert_position(menu)?;

    let file_new = command_item(
        app,
        "file.new_document",
        "New Document",
        Some("CmdOrCtrl+N"),
    )?;
    let file_save = command_item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?;
    let file_snapshot = command_item(app, "file.snapshot", "Snapshot", Some("CmdOrCtrl+Shift+S"))?;
    // Native accelerators only on macOS: a native Ctrl+W/Ctrl+Shift+W on
    // Windows/Linux would consume the key before the webview sees it, breaking
    // shell delete-word in the terminal and the terminal shortcut rebinds.
    #[cfg(target_os = "macos")]
    const CLOSE_ACTIVE_ACCELERATOR: Option<&str> = Some("CmdOrCtrl+W");
    #[cfg(not(target_os = "macos"))]
    const CLOSE_ACTIVE_ACCELERATOR: Option<&str> = None;
    #[cfg(target_os = "macos")]
    const CLOSE_WINDOW_ACCELERATOR: Option<&str> = Some("CmdOrCtrl+Shift+W");
    #[cfg(not(target_os = "macos"))]
    const CLOSE_WINDOW_ACCELERATOR: Option<&str> = None;

    let file_close_active = command_item(
        app,
        "file.close_active",
        "Close Active",
        CLOSE_ACTIVE_ACCELERATOR,
    )?;
    let file_add_workspace = command_item(app, "file.add_workspace", "Add Workspace...", None)?;
    let file_preferences = command_item(
        app,
        "file.preferences",
        "Preferences...",
        Some("CmdOrCtrl+,"),
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &file_new,
            &file_save,
            &file_snapshot,
            &file_close_active,
            &PredefinedMenuItem::separator(app)?,
            &file_add_workspace,
            &file_preferences,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_documents = command_item(app, "view.documents", "Documents", None)?;
    let view_files = command_item(app, "view.files", "Files", None)?;
    let view_documents_pane =
        command_item(app, "view.toggle_documents", "Toggle Explorer Pane", None)?;
    let view_right = command_item(
        app,
        "view.toggle_right",
        "Toggle Right Pane",
        Some("CmdOrCtrl+\\"),
    )?;
    let view_palette = command_item(
        app,
        "view.command_palette",
        "Command Palette",
        Some("CmdOrCtrl+K"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &view_documents,
            &view_files,
            &PredefinedMenuItem::separator(app)?,
            &view_documents_pane,
            &view_right,
            &PredefinedMenuItem::separator(app)?,
            &view_palette,
        ],
    )?;

    let go_back = command_item(app, "go.back", "Back", Some("CmdOrCtrl+["))?;
    let go_forward = command_item(app, "go.forward", "Forward", Some("CmdOrCtrl+]"))?;
    let go_private = command_item(app, "go.private_workspace", "Private Workspace", None)?;
    let go_public = command_item(app, "go.public_workspace", "Public Workspace", None)?;
    let go_prev_tab = command_item(app, "go.previous_tab", "Previous Tab", None)?;
    let go_next_tab = command_item(app, "go.next_tab", "Next Tab", None)?;
    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &go_back,
            &go_forward,
            &PredefinedMenuItem::separator(app)?,
            &go_private,
            &go_public,
            &PredefinedMenuItem::separator(app)?,
            &go_prev_tab,
            &go_next_tab,
        ],
    )?;

    let terminal_shell = command_item(app, "terminal.shell", "New Shell", None)?;
    let terminal_claude = command_item(app, "terminal.claude", "New Claude Code", None)?;
    let terminal_codex = command_item(app, "terminal.codex", "New Codex", None)?;
    let terminal_split =
        command_item(app, "terminal.split", "Split Terminal", Some("CmdOrCtrl+D"))?;
    let terminal_dock_right =
        command_item(app, "terminal.dock_right", "Dock Terminal Right", None)?;
    let terminal_dock_bottom =
        command_item(app, "terminal.dock_bottom", "Dock Terminal Bottom", None)?;
    let terminal_menu = Submenu::with_items(
        app,
        "Terminal",
        true,
        &[
            &terminal_shell,
            &terminal_claude,
            &terminal_codex,
            &PredefinedMenuItem::separator(app)?,
            &terminal_split,
            &PredefinedMenuItem::separator(app)?,
            &terminal_dock_right,
            &terminal_dock_bottom,
        ],
    )?;

    let workspace_refresh = command_item(
        app,
        "workspace.refresh",
        "Refresh Workspace",
        Some("CmdOrCtrl+R"),
    )?;
    let workspace_reveal = command_item(app, "workspace.reveal", "Reveal Workspace", None)?;
    let workspace_commit = command_item(app, "workspace.commit", "Commit Changes", None)?;
    let workspace_menu = Submenu::with_items(
        app,
        "Workspace",
        true,
        &[&workspace_refresh, &workspace_reveal, &workspace_commit],
    )?;
    let window_close = command_item(
        app,
        "window.close",
        "Close Window",
        CLOSE_WINDOW_ACCELERATOR,
    )?;
    let window_minimize = PredefinedMenuItem::minimize(app, None)?;
    let window_maximize = PredefinedMenuItem::maximize(app, None)?;
    let window_fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let window_separator = PredefinedMenuItem::separator(app)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &window_minimize,
            &window_maximize,
            &window_fullscreen,
            &window_separator,
            &window_close,
        ],
    )?;
    // Restore the native window list/tiling entries lost when the default
    // "Window" submenu was removed above.
    #[cfg(target_os = "macos")]
    window_menu.set_as_windows_menu_for_nsapp()?;
    menu.insert_items(
        &[
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &terminal_menu,
            &workspace_menu,
            &window_menu,
        ],
        insert_at,
    )?;
    Ok(())
}

fn remove_default_submenus<R: Runtime>(menu: &Menu<R>, labels: &[&str]) -> tauri::Result<()> {
    for (index, item) in menu.items()?.into_iter().enumerate().rev() {
        if let MenuItemKind::Submenu(submenu) = item {
            let text = submenu.text()?;
            if labels.iter().any(|label| text == *label) {
                let _ = menu.remove_at(index)?;
            }
        }
    }
    Ok(())
}

fn maru_menu_insert_position<R: Runtime>(menu: &Menu<R>) -> tauri::Result<usize> {
    #[cfg(target_os = "macos")]
    {
        Ok(usize::from(!menu.items()?.is_empty()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = menu;
        Ok(0)
    }
}

fn command_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accelerator)
}

#[cfg(target_os = "macos")]
fn insert_check_for_updates_item<R: Runtime>(
    _app: &AppHandle<R>,
    menu: &Menu<R>,
    check_for_updates: &MenuItem<R>,
) -> tauri::Result<()> {
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert(check_for_updates, 1)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn insert_check_for_updates_item<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Menu<R>,
    check_for_updates: &MenuItem<R>,
) -> tauri::Result<()> {
    if let Some(MenuItemKind::Submenu(help_menu)) = menu.get(HELP_SUBMENU_ID) {
        help_menu.prepend(&PredefinedMenuItem::separator(app)?)?;
        help_menu.prepend(check_for_updates)?;
    } else {
        let help_menu = Submenu::with_items(app, "Help", true, &[check_for_updates])?;
        menu.append(&help_menu)?;
    }
    Ok(())
}

/// Where `handle_menu_event` routes a menu command id. Split out as its own
/// pure function (review finding #2) so the routing decision — the part a
/// prior review found broken — is unit-testable without a real window
/// manager, webview, or MenuEvent construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuCommandTarget<'a> {
    Label(&'a str),
    Broadcast,
}

fn menu_command_target<'a>(
    id: &str,
    focused_label: Option<&'a str>,
    main_exists: bool,
    any_window_label: Option<&'a str>,
) -> MenuCommandTarget<'a> {
    // D-03 follow-up: Cmd+Q/app-menu Quit must always reach "main", never a
    // secondary window like skill-editor, which has no whole-app-quit
    // orchestration of its own and would otherwise leave Cmd+Q dead whenever
    // it happens to have focus. "main" asks every other open window's own
    // guard before it lets the app actually exit — see requestAppQuit in
    // useDestructiveActionGuard.ts.
    #[cfg(target_os = "macos")]
    {
        if id == QUIT_MENU_ID {
            if main_exists {
                return MenuCommandTarget::Label("main");
            }
            // Round 2 (owner-observed regression): "main" no longer exists
            // (e.g. it was closed directly while a secondary window stayed
            // open, orphaning it) — emit_to a label with no window behind
            // it reaches nobody, and every later Cmd+Q would go dead
            // forever. Route to any live window instead; its own JS quits
            // the whole app through its own guard (SkillEditorWindow.tsx's
            // app.quit fallback, exit() via @tauri-apps/plugin-process).
            return match any_window_label {
                Some(label) => MenuCommandTarget::Label(label),
                None => MenuCommandTarget::Broadcast,
            };
        }
    }
    // Only the macOS Quit route above reads these.
    #[cfg(not(target_os = "macos"))]
    let _ = (id, main_exists, any_window_label);
    // Every other menu command goes to the focused window only: a broadcast
    // made one Cmd+W act in every window at once (e.g. closing a background
    // PTY tab while the Settings window closed itself). Fall back to
    // broadcast if no window reports focus so menus never go dead.
    match focused_label {
        Some(label) => MenuCommandTarget::Label(label),
        None => MenuCommandTarget::Broadcast,
    }
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() == CHECK_FOR_UPDATES_MENU_ID {
        let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
        return;
    }
    let id = event.id().0.clone();
    let windows = app.webview_windows();
    let focused = windows
        .iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone());
    let main_exists = windows.contains_key("main");
    let any_window_label = windows.keys().next().cloned();
    match menu_command_target(
        &id,
        focused.as_deref(),
        main_exists,
        any_window_label.as_deref(),
    ) {
        MenuCommandTarget::Label(label) => {
            let _ = app.emit_to(label, MENU_COMMAND_EVENT, id);
        }
        MenuCommandTarget::Broadcast => {
            let _ = app.emit(MENU_COMMAND_EVENT, id);
        }
    }
}

#[cfg(test)]
mod menu_routing_tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn quit_always_routes_to_main_regardless_of_focus() {
        assert_eq!(
            menu_command_target(QUIT_MENU_ID, Some("skill-editor"), true, Some("main")),
            MenuCommandTarget::Label("main"),
        );
        assert_eq!(
            menu_command_target(QUIT_MENU_ID, Some("main"), true, Some("main")),
            MenuCommandTarget::Label("main"),
        );
        assert_eq!(
            menu_command_target(QUIT_MENU_ID, None, true, Some("main")),
            MenuCommandTarget::Label("main"),
        );
    }

    // Round 2 (owner-observed regression): "main" closed directly (or was
    // orphaned by the round-1 initializing-window race) while a secondary
    // window stayed open. Every later Cmd+Q must still reach a live window
    // instead of going nowhere.
    #[test]
    #[cfg(target_os = "macos")]
    fn quit_falls_back_to_a_live_window_when_main_no_longer_exists() {
        assert_eq!(
            menu_command_target(
                QUIT_MENU_ID,
                Some("skill-editor"),
                false,
                Some("skill-editor")
            ),
            MenuCommandTarget::Label("skill-editor"),
        );
        // Even if the (now-gone) "main" still happened to report focus in a
        // stale snapshot, main_exists=false must win the fallback decision.
        assert_eq!(
            menu_command_target(QUIT_MENU_ID, Some("main"), false, Some("skill-editor")),
            MenuCommandTarget::Label("skill-editor"),
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn quit_broadcasts_when_main_is_gone_and_no_window_remains() {
        assert_eq!(
            menu_command_target(QUIT_MENU_ID, None, false, None),
            MenuCommandTarget::Broadcast,
        );
    }

    #[test]
    fn every_other_command_follows_focus_or_broadcasts() {
        assert_eq!(
            menu_command_target("window.close", Some("skill-editor"), true, Some("main")),
            MenuCommandTarget::Label("skill-editor"),
        );
        assert_eq!(
            menu_command_target("window.close", Some("main"), true, Some("main")),
            MenuCommandTarget::Label("main"),
        );
        assert_eq!(
            menu_command_target("window.close", None, true, Some("main")),
            MenuCommandTarget::Broadcast,
        );
    }
}
