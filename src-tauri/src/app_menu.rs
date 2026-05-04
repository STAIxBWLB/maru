use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle, Emitter, Runtime,
};

#[cfg(not(target_os = "macos"))]
use tauri::menu::{PredefinedMenuItem, Submenu, HELP_SUBMENU_ID};

const CHECK_FOR_UPDATES_MENU_ID: &str = "app.check_for_updates";
const CHECK_FOR_UPDATES_EVENT: &str = "anchor://check-for-updates";

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let check_for_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates...",
        true,
        None::<&str>,
    )?;

    insert_check_for_updates_item(app, &menu, &check_for_updates)?;
    Ok(menu)
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
    }
}
