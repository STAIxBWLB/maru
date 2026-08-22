//! Browser-passkey authorization for the native Sites webview.
//!
//! WebKit owns WebAuthn, relying-party validation, and the credential result.
//! This module only exposes Apple's browser-level permission gate to the main
//! Maru webview. It deliberately accepts no relying party, challenge, or
//! credential input, so it cannot become a second WebAuthn implementation or
//! a confused-deputy surface for remote pages.

use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;

#[cfg(target_os = "macos")]
use {
    block2::RcBlock,
    core_foundation_sys::{
        base::{CFGetTypeID, CFRelease, CFTypeRef},
        error::CFErrorRef,
        number::{CFBooleanGetTypeID, CFBooleanGetValue, CFBooleanRef},
        string::{kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef},
    },
    objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    },
    std::{
        ffi::c_void,
        ptr,
        sync::{Mutex, OnceLock},
    },
    tauri::Manager,
};

#[cfg(target_os = "macos")]
type SecTaskRef = *const c_void;

#[cfg(target_os = "macos")]
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTaskCreateFromSelf(allocator: *const c_void) -> SecTaskRef;
    fn SecTaskCopyValueForEntitlement(
        task: SecTaskRef,
        entitlement: CFStringRef,
        error: *mut CFErrorRef,
    ) -> CFTypeRef;
    fn dlopen(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> *mut c_void;
}

#[cfg(target_os = "macos")]
const BROWSER_PASSKEY_ENTITLEMENT: &std::ffi::CStr =
    c"com.apple.developer.web-browser.public-key-credential";

#[cfg(target_os = "macos")]
const AUTHENTICATION_SERVICES_PATH: &std::ffi::CStr =
    c"/System/Library/Frameworks/AuthenticationServices.framework/AuthenticationServices";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPasskeyAuthorization {
    #[cfg(any(target_os = "macos", test))]
    Authorized,
    #[cfg(any(target_os = "macos", test))]
    Denied,
    #[cfg(any(target_os = "macos", test))]
    NotDetermined,
    #[cfg(any(target_os = "macos", test))]
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPasskeyStatus {
    pub supported: bool,
    pub authorization: BrowserPasskeyAuthorization,
    pub requires_managed_entitlement: bool,
}

pub struct BrowserPasskeyState {
    request_in_flight: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    manager: Mutex<Option<usize>>,
}

impl Default for BrowserPasskeyState {
    fn default() -> Self {
        Self {
            request_in_flight: Arc::new(AtomicBool::new(false)),
            #[cfg(target_os = "macos")]
            manager: Mutex::new(None),
        }
    }
}

fn unsupported_status() -> BrowserPasskeyStatus {
    BrowserPasskeyStatus {
        supported: false,
        authorization: BrowserPasskeyAuthorization::Unsupported,
        requires_managed_entitlement: cfg!(target_os = "macos"),
    }
}

#[cfg(any(target_os = "macos", test))]
fn authorization_from_raw(value: isize) -> BrowserPasskeyAuthorization {
    match value {
        0 => BrowserPasskeyAuthorization::Authorized,
        1 => BrowserPasskeyAuthorization::Denied,
        2 => BrowserPasskeyAuthorization::NotDetermined,
        _ => BrowserPasskeyAuthorization::Unknown,
    }
}

#[cfg(any(target_os = "macos", test))]
fn status_from_runtime_capabilities(
    has_managed_entitlement: bool,
    manager_available: bool,
    authorization: isize,
) -> BrowserPasskeyStatus {
    if !has_managed_entitlement || !manager_available {
        return unsupported_status();
    }
    BrowserPasskeyStatus {
        supported: true,
        authorization: authorization_from_raw(authorization),
        requires_managed_entitlement: true,
    }
}

#[cfg(target_os = "macos")]
fn manager_is_available() -> bool {
    // AuthenticationServices is not present on every macOS version supported
    // by Maru. Keep the framework weak at runtime instead of adding a strong
    // load command that prevents the whole app from launching on older macOS.
    static FRAMEWORK_HANDLE: OnceLock<Option<usize>> = OnceLock::new();
    let loaded = FRAMEWORK_HANDLE.get_or_init(|| unsafe {
        // RTLD_LAZY | RTLD_LOCAL on Darwin. Keep the handle for the process
        // lifetime because Objective-C class pointers from it remain in use.
        let handle = dlopen(AUTHENTICATION_SERVICES_PATH.as_ptr(), 0x1 | 0x4);
        (!handle.is_null()).then_some(handle as usize)
    });
    loaded.is_some()
        && AnyClass::get(c"ASAuthorizationWebBrowserPublicKeyCredentialManager").is_some()
}

#[cfg(target_os = "macos")]
fn has_browser_passkey_entitlement() -> bool {
    // SecTask reads the effective code-signature entitlement of this running
    // process. Info.plist declarations and build-time config are deliberately
    // insufficient: the default/ad-hoc build must never touch the managed API.
    unsafe {
        let task = SecTaskCreateFromSelf(ptr::null());
        if task.is_null() {
            return false;
        }
        let key = CFStringCreateWithCString(
            ptr::null(),
            BROWSER_PASSKEY_ENTITLEMENT.as_ptr(),
            kCFStringEncodingUTF8,
        );
        if key.is_null() {
            CFRelease(task as CFTypeRef);
            return false;
        }
        let value = SecTaskCopyValueForEntitlement(task, key, ptr::null_mut());
        let enabled = !value.is_null()
            && CFGetTypeID(value) == CFBooleanGetTypeID()
            && CFBooleanGetValue(value as CFBooleanRef);
        if !value.is_null() {
            CFRelease(value);
        }
        CFRelease(key as CFTypeRef);
        CFRelease(task as CFTypeRef);
        enabled
    }
}

#[cfg(target_os = "macos")]
fn shared_manager(app: &AppHandle) -> Result<*mut AnyObject, String> {
    let state = app.state::<BrowserPasskeyState>();
    let mut manager = state
        .manager
        .lock()
        .map_err(|_| "Browser passkey state is unavailable".to_string())?;
    if manager.is_none() {
        // SAFETY: availability is checked before this function is called, and
        // construction/access is serialized on the main thread. Retaining the
        // one manager for the process lifetime also avoids deallocating this
        // main-thread-only object when Tauri tears down managed state.
        let object: Retained<AnyObject> = unsafe {
            msg_send![
                AnyClass::get(c"ASAuthorizationWebBrowserPublicKeyCredentialManager")
                    .ok_or_else(|| "Browser passkey manager is unavailable".to_string())?,
                new
            ]
        };
        *manager = Some(Retained::into_raw(object) as usize);
    }
    manager
        .map(|pointer| pointer as *mut AnyObject)
        .ok_or_else(|| "Browser passkey manager is unavailable".to_string())
}

#[cfg(target_os = "macos")]
fn native_status(app: &AppHandle) -> Result<BrowserPasskeyStatus, String> {
    if !has_browser_passkey_entitlement() || !manager_is_available() {
        return Ok(unsupported_status());
    }
    let manager = shared_manager(app)?;
    // SAFETY: all access to the non-atomic Objective-C property is dispatched
    // to the main thread by the command wrapper.
    let authorization: isize =
        unsafe { msg_send![manager, authorizationStateForPlatformCredentials] };
    Ok(status_from_runtime_capabilities(true, true, authorization))
}

#[cfg(target_os = "macos")]
async fn status_on_main_thread(app: AppHandle) -> Result<BrowserPasskeyStatus, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.try_send(native_status(&main_app));
    })
    .map_err(|err| format!("Cannot inspect browser passkey authorization: {err}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Browser passkey status did not complete".to_string())?
}

#[tauri::command]
pub async fn browser_passkey_status(app: AppHandle) -> Result<BrowserPasskeyStatus, String> {
    #[cfg(target_os = "macos")]
    {
        status_on_main_thread(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(unsupported_status())
    }
}

struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn browser_passkey_request_authorization(
    app: AppHandle,
    state: tauri::State<'_, BrowserPasskeyState>,
) -> Result<BrowserPasskeyStatus, String> {
    if state
        .request_in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A browser passkey authorization request is already in progress".to_string());
    }
    let _guard = InFlightGuard(Arc::clone(&state.request_in_flight));

    #[cfg(target_os = "macos")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let main_app = app.clone();
        app.run_on_main_thread(move || {
            if !has_browser_passkey_entitlement() || !manager_is_available() {
                let _ = sender.try_send(Ok(unsupported_status()));
                return;
            }
            let manager = match shared_manager(&main_app) {
                Ok(manager) => manager,
                Err(err) => {
                    let _ = sender.try_send(Err(err));
                    return;
                }
            };
            // The state owns the manager for the app lifetime. The system
            // copies this block for the asynchronous authorization prompt.
            let completion = RcBlock::new(move |authorization: isize| {
                let _ = sender.try_send(Ok(BrowserPasskeyStatus {
                    supported: true,
                    authorization: authorization_from_raw(authorization),
                    requires_managed_entitlement: true,
                }));
            });
            let completion: &block2::DynBlock<dyn Fn(isize)> = &completion;
            // SAFETY: the manager is available and this call runs on the main
            // thread in direct response to an explicit frontend user action.
            unsafe {
                let _: () = msg_send![
                    manager,
                    requestAuthorizationForPublicKeyCredentials: completion
                ];
            }
        })
        .map_err(|err| format!("Cannot request browser passkey authorization: {err}"))?;

        receiver
            .recv()
            .await
            .ok_or_else(|| "Browser passkey authorization did not complete".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(unsupported_status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_authorization_values_are_mapped_explicitly() {
        assert_eq!(
            authorization_from_raw(0),
            BrowserPasskeyAuthorization::Authorized
        );
        assert_eq!(
            authorization_from_raw(1),
            BrowserPasskeyAuthorization::Denied
        );
        assert_eq!(
            authorization_from_raw(2),
            BrowserPasskeyAuthorization::NotDetermined
        );
        assert_eq!(
            authorization_from_raw(99),
            BrowserPasskeyAuthorization::Unknown
        );
    }

    #[test]
    fn unsupported_status_does_not_claim_authorization() {
        let status = unsupported_status();
        assert!(!status.supported);
        assert_eq!(
            status.authorization,
            BrowserPasskeyAuthorization::Unsupported
        );
    }

    #[test]
    fn managed_entitlement_is_required_before_reporting_support() {
        let no_entitlement = status_from_runtime_capabilities(false, true, 0);
        let no_manager = status_from_runtime_capabilities(true, false, 0);
        let ready = status_from_runtime_capabilities(true, true, 2);

        assert!(!no_entitlement.supported);
        assert!(!no_manager.supported);
        assert!(ready.supported);
        assert_eq!(
            ready.authorization,
            BrowserPasskeyAuthorization::NotDetermined
        );
    }

    #[test]
    fn in_flight_guard_releases_the_request_slot() {
        let flag = Arc::new(AtomicBool::new(true));
        drop(InFlightGuard(Arc::clone(&flag)));
        assert!(!flag.load(Ordering::Acquire));
    }
}
