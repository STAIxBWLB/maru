//! Real command-wrapper evidence on disposable workspaces, no native UI claim.
use crate::atomic_file::phase08_06::{run, Held, Home};
use crate::atomic_file::{PathTransactionRequest, PathTransactionTestHook};
use crate::scratchpad::phase08_08::registry;
use crate::task_completion::{task_completion, TaskCompletionRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindowBuilder};

const TASK: &str = "tasks/active/isolation.md";
struct Fixture {
    _root: tempfile::TempDir,
    work: PathBuf,
    revision: String,
}
impl Fixture {
    fn new(home: &Home) -> Self {
        let root = tempfile::tempdir_in(home.root.path()).unwrap();
        let work = root.path().to_path_buf();
        std::fs::create_dir_all(work.join("tasks/active")).unwrap();
        std::fs::create_dir_all(work.join(".maru")).unwrap();
        let source = "---\ntitle: Isolation fixture\nstatus: active\n---\n# Original\n";
        std::fs::write(work.join(TASK), source).unwrap();
        registry(&work, "direct");
        Self {
            _root: root,
            work,
            revision: format!("{:x}", Sha256::digest(source.as_bytes())),
        }
    }
    fn policy(&self) -> TaskCompletionRequest {
        TaskCompletionRequest::SetPolicy {
            task_path: TASK.into(),
            required: true,
            expected_revision: self.revision.clone(),
        }
    }
    fn work_string(&self) -> String {
        self.work.to_string_lossy().into_owned()
    }
}
fn mock_app() -> tauri::App<MockRuntime> {
    tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::task_completion::task_completion
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}
fn request(work: &str, payload: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: "task_completion".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({"workPath":work,"request":payload})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }
}

pub(crate) fn task_completion_isolation_actual_wrapper_yields_and_maps_worker_failure() {
    let home = Home::new();
    let fixture = Fixture::new(&home);
    let app = mock_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let _hook =
        PathTransactionTestHook::new(fixture.work.clone(), "worker:task_completion", move || {
            entered_tx
                .blocking_send(std::thread::current().id())
                .unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            panic!("injected completion worker failure");
        });
    run(async move {
        let caller = std::thread::current().id();
        let mut future = Box::pin(task_completion(
            app.handle().clone(),
            main.as_ref().clone(),
            fixture.work_string(),
            fixture.policy(),
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let worker = entered_rx.recv().await.unwrap();
        let mut yielded = false;
        std::future::poll_fn(|cx| {
            if yielded {
                std::task::Poll::Ready(())
            } else {
                yielded = true;
                cx.waker().wake_by_ref();
                std::task::Poll::Pending
            }
        })
        .await;
        assert_ne!(caller, worker);
        release_tx.send(()).unwrap();
        let error = future.await.unwrap_err();
        assert!(
            error.message.contains("Task completion worker failed"),
            "{error:?}"
        );
        assert!(!std::fs::read_to_string(fixture.work.join(TASK))
            .unwrap()
            .contains("maruCompletionRequired"));
    });
}

pub(crate) fn task_completion_isolation_policy_serializes_aliases_rechecks_and_releases() {
    let home = Home::new();
    let fixture = Fixture::new(&home);
    let task = fixture.work.join(TASK);
    let held = Held::new(task.clone(), "admitted");
    let work = fixture.work.clone();
    let revision = fixture.revision.clone();
    let first = std::thread::spawn(move || {
        crate::task_completion::set_policy(&work, TASK, true, &revision)
    });
    held.wait();
    #[cfg(unix)]
    let alias = home.root.path().join("alias-workspace");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&fixture.work, &alias).unwrap();
    #[cfg(not(unix))]
    let alias = fixture.work.join(".");
    let (waiting_tx, waiting_rx) = mpsc::channel();
    let _waiting = PathTransactionTestHook::new(task.clone(), "before-admission", move || {
        waiting_tx.send(()).unwrap();
    });
    let app = mock_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let payload = fixture.policy();
    let (done_tx, done_rx) = mpsc::channel();
    let second = std::thread::spawn(move || {
        let value = run(async move {
            task_completion(
                app.handle().clone(),
                main.as_ref().clone(),
                alias.to_string_lossy().into_owned(),
                payload,
            )
            .await
        });
        done_tx.send(value).unwrap();
    });
    waiting_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    held.release();
    assert!(first.join().unwrap().is_ok());
    let conflict = done_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap_err();
    assert_eq!(conflict.code, crate::ipc_error::DOCUMENT_CONFLICT);
    second.join().unwrap();
    drop(_waiting);
    assert!(std::fs::read_to_string(&task)
        .unwrap()
        .contains("maruCompletionRequired: true"));
    let lease = PathTransactionRequest::new([task])
        .unwrap()
        .try_acquire()
        .unwrap();
    assert!(lease.is_some(), "failed command must release admission");
}

pub(crate) fn task_completion_isolation_unknown_and_forged_actions_are_refused_by_ipc() {
    let home = Home::new();
    let fixture = Fixture::new(&home);
    let app = mock_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let before = std::fs::read(fixture.work.join(TASK)).unwrap();
    for payload in [
        json!({"action":"acceptWithoutReview","taskPath":TASK}),
        json!({"action":"setPolicy","taskPath":TASK,"required":true,"expectedRevision":fixture.revision,"actor":"person"}),
        json!({"action":"review","token":{"taskId":"x","requestId":"x","runId":"x","generation":1},"bindingRevision":"x","provider":"codex","requestId":"x","reviewerPrincipal":"claude"}),
    ] {
        assert!(get_ipc_response(&main, request(&fixture.work_string(), payload)).is_err());
        assert_eq!(std::fs::read(fixture.work.join(TASK)).unwrap(), before);
    }
    assert!(!fixture.work.join(".maru/task-completion").exists());
}

pub(crate) fn task_completion_isolation_command_requires_main_webview_and_window() {
    let home = Home::new();
    let fixture = Fixture::new(&home);
    let app = mock_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let sites = WebviewWindowBuilder::new(&app, "sites", Default::default())
        .build()
        .unwrap();
    let payload = json!({"action":"read","taskPath":TASK});
    assert!(get_ipc_response(&main, request(&fixture.work_string(), payload.clone())).is_ok());
    let refused = get_ipc_response(&sites, request(&fixture.work_string(), payload)).unwrap_err();
    assert_eq!(refused["code"], "task_completion_refused");
    let child = main
        .as_ref()
        .window()
        .add_child(
            tauri::WebviewBuilder::new("local-child", tauri::WebviewUrl::default()),
            tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)),
            tauri::Size::Logical(tauri::LogicalSize::new(100.0, 100.0)),
        )
        .unwrap();
    let work = fixture.work_string();
    let result = run(async move {
        task_completion(
            app.handle().clone(),
            child,
            work,
            TaskCompletionRequest::Read {
                task_path: TASK.into(),
            },
        )
        .await
    });
    assert_eq!(result.unwrap_err().code, "task_completion_refused");
    let before = std::fs::read(fixture.work.join(TASK)).unwrap();
    // A webview called main inside another window must also be refused.
    let other_app = mock_app();
    let other_window = tauri::WindowBuilder::new(&other_app, "other-window")
        .build()
        .unwrap();
    let disguised = other_window
        .add_child(
            tauri::WebviewBuilder::new("main", tauri::WebviewUrl::default()),
            tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)),
            tauri::Size::Logical(tauri::LogicalSize::new(100.0, 100.0)),
        )
        .unwrap();
    let work = fixture.work_string();
    let result = run(async move {
        task_completion(
            other_app.handle().clone(),
            disguised,
            work,
            TaskCompletionRequest::Read {
                task_path: TASK.into(),
            },
        )
        .await
    });
    assert_eq!(result.unwrap_err().code, "task_completion_refused");
    assert_eq!(std::fs::read(fixture.work.join(TASK)).unwrap(), before);
}
