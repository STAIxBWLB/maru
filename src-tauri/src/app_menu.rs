use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

#[cfg(not(target_os = "macos"))]
use tauri::menu::HELP_SUBMENU_ID;

const CHECK_FOR_UPDATES_MENU_ID: &str = "app.check_for_updates";
const CHECK_FOR_UPDATES_EVENT: &str = "anchor://check-for-updates";
const MENU_COMMAND_EVENT: &str = "anchor://menu-command";

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let check_for_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates...",
        true,
        None::<&str>,
    )?;

    install_anchor_menus(app, &menu)?;
    insert_check_for_updates_item(app, &menu, &check_for_updates)?;
    Ok(menu)
}

fn install_anchor_menus<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    remove_default_submenus(menu, &["File", "Edit", "View"])?;
    let insert_at = anchor_menu_insert_position(menu)?;

    let file_new = command_item(
        app,
        "file.new_document",
        "New Document",
        Some("CmdOrCtrl+N"),
    )?;
    let file_save = command_item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?;
    let file_snapshot = command_item(app, "file.snapshot", "Snapshot", Some("CmdOrCtrl+Shift+S"))?;
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
    menu.insert_items(
        &[
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &terminal_menu,
            &workspace_menu,
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

fn anchor_menu_insert_position<R: Runtime>(menu: &Menu<R>) -> tauri::Result<usize> {
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

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() == CHECK_FOR_UPDATES_MENU_ID {
        let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
    } else {
        let _ = app.emit(MENU_COMMAND_EVENT, event.id().0.clone());
    }
}
