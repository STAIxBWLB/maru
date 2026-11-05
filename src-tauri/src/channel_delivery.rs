//! Recipient-bound channel delivery with the existing callback/index envelope.

use tauri::{
    ipc::{CallbackFn, InvokeResponseBody},
    Runtime, Webview,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryFailure {
    Recipient,
    Format,
    Eval,
}

impl std::fmt::Display for DeliveryFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Recipient => "the bound webview is unavailable or outside the app",
            Self::Format => "the channel body could not be formatted for inline delivery",
            Self::Eval => "inline delivery could not be scheduled on the bound webview",
        })
    }
}

fn inline_script(
    callback: CallbackFn,
    index: usize,
    body: &InvokeResponseBody,
) -> Result<String, DeliveryFailure> {
    let (expression, bytes) = match body {
        InvokeResponseBody::Json(json) => {
            serde_json::from_str::<serde::de::IgnoredAny>(json)
                .map_err(|_| DeliveryFailure::Format)?;
            let quoted = serde_json::to_string(json).map_err(|_| DeliveryFailure::Format)?;
            (format!("JSON.parse({quoted})"), json.len())
        }
        InvokeResponseBody::Raw(bytes) => {
            let array = serde_json::to_string(bytes).map_err(|_| DeliveryFailure::Format)?;
            (format!("new Uint8Array({array}).buffer"), bytes.len())
        }
    };
    Ok(callback_script(callback, index, &expression, bytes))
}

#[cfg(not(feature = "native-e2e"))]
fn callback_script(callback: CallbackFn, index: usize, expression: &str, _bytes: usize) -> String {
    format!(
        "window.__TAURI_INTERNALS__.runCallback({}, {{ message: {}, index: {} }})",
        callback.0, expression, index
    )
}

#[cfg(feature = "native-e2e")]
fn callback_script(callback: CallbackFn, index: usize, expression: &str, bytes: usize) -> String {
    let callback = callback.0;
    // Timing covers JSON parsing and the receiver's synchronous callback, not
    // generated-script compilation, Rust preparation, native dispatch or paint.
    format!(
        r#"(() => {{
const started = performance.now();
const message = {expression};
try {{
  window.__TAURI_INTERNALS__.runCallback({callback}, {{ message, index: {index} }});
}} finally {{
  if (message && message.kind === 'frame' && message.frame) {{
    window.__MARU_NATIVE_E2E__?.recordChannelEval?.({{
      bytes: {bytes}, durationMs: performance.now() - started,
      sessionId: message.sessionId, cols: message.frame.cols, rows: message.frame.rows,
      fullFrame: message.frame.dirtyRows === null
    }});
  }}
}}
}})()"#
    )
}

/// The return value always consumes the message, including errors. Returning
/// false here would allow the framework to choose a different transport.
pub(crate) fn intercept<R: Runtime>(
    webview: &Webview<R>,
    callback: CallbackFn,
    index: usize,
    body: &InvokeResponseBody,
) -> bool {
    intercept_with_eval(webview, callback, index, body, |target, script| {
        target.eval(script).map_err(|_| ())
    })
}

pub(crate) fn intercept_with_eval<R: Runtime>(
    webview: &Webview<R>,
    callback: CallbackFn,
    index: usize,
    body: &InvokeResponseBody,
    eval: impl FnOnce(&Webview<R>, String) -> Result<(), ()>,
) -> bool {
    let result = if crate::ipc_policy::is_first_party_webview(webview) {
        inline_script(callback, index, body)
            .and_then(|script| eval(webview, script).map_err(|_| DeliveryFailure::Eval))
    } else {
        Err(DeliveryFailure::Recipient)
    };
    if let Err(failure) = result {
        // Diagnostics deliberately omit body content, URL and platform errors
        // that could include the evaluated script.
        eprintln!(
            "channel_delivery_failed: {failure}; close and reopen the receiving view, then retry"
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_json_preserves_callback_index_and_quoted_unicode_data() {
        let value = serde_json::json!({"text": "한글 🧪 'quoted' \\", "rows": [1, 2]});
        let json = serde_json::to_string(&value).unwrap();
        let script = inline_script(CallbackFn(41), 7, &InvokeResponseBody::Json(json)).unwrap();
        let quoted = script.split_once("JSON.parse(").unwrap().1;
        let decoded = serde_json::Deserializer::from_str(quoted)
            .into_iter::<String>()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&decoded).unwrap(),
            value
        );
        assert!(script.contains("runCallback(41,"));
        assert!(script.contains("index: 7"));
    }

    #[test]
    fn inline_raw_keeps_array_buffer_shape_for_large_messages() {
        let script =
            inline_script(CallbackFn(8), 2, &InvokeResponseBody::Raw(vec![255; 2048])).unwrap();
        assert!(script.contains("new Uint8Array([255,255,"));
        assert!(script.contains("]).buffer"));
        assert!(script.contains("runCallback(8,"));
        assert!(script.contains("index: 2"));
    }

    #[test]
    fn malformed_json_is_refused_before_scheduling_delivery() {
        assert_eq!(
            inline_script(
                CallbackFn(8),
                2,
                &InvokeResponseBody::Json("not JSON".into())
            ),
            Err(DeliveryFailure::Format)
        );
    }
}
