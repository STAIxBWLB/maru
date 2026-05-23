# Third-Party Notices

Anchor is currently UNLICENSED. The following notice records selectively adapted
ideas or code patterns used inside this private repository.

## kordoc

- Source: <https://github.com/chrisryugj/kordoc>
- License: MIT
- Anchor usage: `src-tauri/src/kordoc_lite.rs` selectively ports document
  format detection, HWPX ZIP/XML safety checks, Korean public-form label
  recognition, and conservative HWPX form-fill behavior. Anchor does not vendor
  the kordoc package or runtime.
