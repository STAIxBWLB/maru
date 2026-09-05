//! Poison-recovery guard helper shared by the six named process-global locks
//! (PERF-03). See `<behavior>` in 07-02-PLAN.md; the helper itself lands in
//! the GREEN commit of the tracer task.

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
        assert!(mutex.lock().is_ok());
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
            recover_guard(mutex.lock().unwrap_err(), "test", "POISONED_LOCK");
        // A second acquirer still blocks while the recovered guard is held.
        assert!(mutex.try_lock().is_err());
        drop(recovered);
        assert!(mutex.try_lock().is_ok());
    }

    #[test]
    fn helper_emits_exactly_one_warn_line() {
        // D-01: visibility is exactly one eprintln! warn line per recovery,
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
