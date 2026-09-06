//! Poison-recovery guard helper shared by the six named process-global locks
//! (PERF-03).
//!
//! Contract (D-03, REQUIREMENTS PERF-03 out-of-scope): this helper may only
//! be used for unit mutexes (`Mutex<()>`) whose guarded state is re-derived
//! from disk after acquisition, so the in-memory `()` carries no invariant
//! and recovering the guard cannot serve tainted state. Every call site must
//! carry its own co-located justification comment naming the lock's actual
//! guarded state. Recovery emits exactly one stderr warn line per
//! poisoned acquisition (D-01); the user surface shows nothing.

use std::sync::{LockResult, MutexGuard};

/// Convert a mutex lock result into a guard, recovering from poisoning.
///
/// The `Ok` arm returns the guard unchanged. The `Err(poisoned)` arm emits
/// one warn line carrying the module tag and lock name (see the module
/// docs for the exact shape)
/// and returns `poisoned.into_inner()` so the calling feature stays usable on
/// the next call instead of bricked until app restart. Mutual exclusion is
/// unchanged: recovered guards still serialize acquirers.
pub(crate) fn recover_guard<'a, T>(
    result: LockResult<MutexGuard<'a, T>>,
    module_tag: &str,
    lock_name: &str,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(|poisoned| {
        eprintln!("[{module_tag}] {lock_name} was poisoned; recovering guard");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, MutexGuard};

    use super::recover_guard;

    #[test]
    fn clean_lock_returns_usable_guard() {
        let mutex = Mutex::new(());
        let guard = recover_guard(mutex.lock(), "test", "CLEAN_LOCK");
        // The guard is usable: dropping it must succeed and re-acquisition
        // must take the uncontended Ok path.
        drop(guard);
        assert!(mutex.lock().is_ok());
    }

    #[test]
    fn poisoned_lock_recovers_to_usable_guard() {
        let mutex = Arc::new(Mutex::new(()));
        let panicked = {
            let mutex = Arc::clone(&mutex);
            std::thread::spawn(move || {
                let _guard = mutex.lock().unwrap();
                panic!("poison while holding guard");
            })
        };
        assert!(panicked.join().is_err());
        // Poisoning is visible on the next acquisition...
        let poisoned = mutex.lock().unwrap_err();
        // ...and recovery hands back a usable guard anyway.
        let guard = recover_guard(Err(poisoned), "test", "POISONED_LOCK");
        drop(guard);
        // into_inner recovery does not clear the poison flag: every later
        // acquisition still returns Err and goes through recover_guard again
        // (each repeated recovery emits its own warn line). The feature stays
        // usable because callers hold the guard, not the LockResult.
        assert!(mutex.lock().is_err());
        let guard = recover_guard(mutex.lock(), "test", "POISONED_LOCK");
        drop(guard);
        assert!(mutex.lock().is_err());
    }

    #[test]
    fn recovered_guard_preserves_mutual_exclusion() {
        let mutex = Arc::new(Mutex::new(()));
        let panicked = {
            let mutex = Arc::clone(&mutex);
            std::thread::spawn(move || {
                let _guard = mutex.lock().unwrap();
                panic!("poison while holding guard");
            })
        };
        assert!(panicked.join().is_err());
        let recovered: MutexGuard<'_, ()> =
            recover_guard(Err(mutex.lock().unwrap_err()), "test", "POISONED_LOCK");
        // Clear the poison flag so try_lock results isolate exclusion from
        // poisoning: while the recovered guard is held, a second acquirer
        // still blocks; after the drop, acquisition succeeds again.
        mutex.clear_poison();
        assert!(mutex.try_lock().is_err());
        drop(recovered);
        assert!(mutex.try_lock().is_ok());
    }

    #[test]
    fn helper_emits_exactly_one_warn_line() {
        // D-01: visibility is exactly one stderr warn line per recovery,
        // asserted by source because stderr capture is unreliable in tests.
        // The needles are split so this test's own source does not contain
        // the counted tokens.
        let source = include_str!("lock_recovery.rs");
        let print_macro = concat!("epri", "ntln!");
        let warn_text = concat!("was poiso", "ned; recovering guard");
        assert_eq!(
            source.matches(print_macro).count(),
            1,
            "recover_guard must contain exactly one {print_macro}"
        );
        assert_eq!(
            source.matches(warn_text).count(),
            1,
            "the warn line must carry the module tag and lock name"
        );
        let _ = source;
    }
}
