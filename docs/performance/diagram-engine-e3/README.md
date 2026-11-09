# E3 PNG measurement evidence

- `png-wasm-transport.json`: real isolated Vite ES adapter with the PNG WASM/font module, measured at `9bace127`. One browser realm measures import/initialization and then typical and dense source-to-artifact calls. The dense first call reuses initialized font state.
- `png-native-raster.json`: native raster probe at `321a880e`. Layout is measured separately; render includes SVG gates and PNG encode/decode.
- `png-mock-ipc-transport.json`: registered Tauri MockRuntime dispatch to awaited worker rendering at `9fc4d968`. Both fixture tests passed. This does not measure WebView or OS IPC; do not promote it to native desktop latency evidence.
- `png-native-linux.json`: 12-scene native manifest at `9fc4d968`, including repeated PNG bytes and pinned font identities.
- `png-wasm-linux.json`: the same 12-scene WASM manifest at `677bd809`. It is exactly equal to the native Linux manifest. The intervening source changes only repair CLI evidence output and remove an unused import; the raster implementation is unchanged.

These reports are direct JSON emitted by the tools, without constructed timing samples or invented platform results. The four-report hosted gate obtains its own reports from Linux, macOS, Windows and WASM at the submitted head. The two archived Linux reports do not satisfy that gate by themselves.

The validation artifact measurement at the WASM transport head was 324,220 B gzip. The separately loaded PNG ES module was 36,321,493 B gzip. Measurement code is `scripts/diagram-engine-e3-png-measure.mjs`; fixture/native tools are in the engine crate.
