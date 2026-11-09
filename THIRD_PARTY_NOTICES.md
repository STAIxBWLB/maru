# Third-Party Notices

Maru application code is currently UNLICENSED. Separately licensed third-party
materials retain their own terms.

## Noto Sans CJK KR metric data

The diagram engine's geometry feature carries derived metric tables from Noto
Sans CJK KR Regular and Bold, from upstream revision
`f8d157532fbfaeda587e826d4cd5b21a49186f7c`. These tables are separately licensed
under SIL Open Font License 1.1. The complete copyright/licence, immutable source
URLs, source font hashes and derived table hashes are stored beside the data in
`src-tauri/crates/maru-diagram-engine/src/metrics/data/`.

The default validator does not bundle these tables. The host generator parses
pinned original font files; it never reads installed system fonts.

HWPX form handling uses the released `hwp` binary, which carries its own notices.

## Unicode default-ignorable property data

The geometry text policy uses the Default_Ignorable_Code_Point ranges from
Unicode 17.0.0 `DerivedCoreProperties.txt`. The source and version are recorded
in `src-tauri/crates/maru-diagram-engine/src/metrics/README.md`; the accompanying
Unicode License V3 copyright and permission notice is retained in
`src-tauri/crates/maru-diagram-engine/src/metrics/UNICODE-LICENSE.txt`.

## roxmltree 0.21.1

The optional `render-svg` feature uses roxmltree 0.21.1 for independent SVG XML
artifact parsing. It is licensed under MIT OR Apache-2.0. Upstream source and
complete licences: https://github.com/RazrFalcon/roxmltree/tree/v0.21.1
(`LICENSE-MIT`, `LICENSE-APACHE`). Maru selects the MIT option; the complete
MIT copyright and licence are retained in the engine at
`src/render/licenses/roxmltree-MIT.txt`. It is not enabled by the default validator.

## Noto Sans CJK KR glyph-zero outlines

The SVG feature carries two derived glyph-zero SVG paths in
`src-tauri/crates/maru-diagram-engine/src/render/notdef.json`, generated from the
same pinned Regular/Bold OTFs as the E2 metric tables. These paths remain under
OFL-1.1; full licence and copyright are retained in `src/metrics/data/LICENSE.OFL`
and `src/metrics/data/NOTICE.md` within the engine crate. The source SHA-256 and units-per-em are
recorded alongside each path. For SVG-only builds, original font binaries are remote test fixtures,
not embedded in the validator or SVG. Supported scalars reference the Noto font
family with shaping disabled; unsupported scalars draw the actual glyph zero.

## PNG rasterizer and bundled fonts

The optional `render-png` feature uses resvg/usvg 0.49.0 (Apache-2.0 OR MIT,
MIT option selected), and tiny-skia/tiny-skia-path 0.12.0 (BSD-3-Clause).
It enables text only, without system-font discovery, memory-mapped fonts,
SVGZ or raster-image decoding. The resvg and tiny-skia copyright/licence texts
are retained under `src-tauri/crates/maru-diagram-engine/src/render/licenses/`.
Upstream: https://github.com/linebender/resvg/tree/v0.49.0 and
https://github.com/linebender/tiny-skia/tree/v0.12.0.

PNG builds bundle the original Noto Sans CJK KR Regular/Bold OTFs under
`src-tauri/crates/maru-diagram-engine/src/render/fonts/`, from the same
`f8d157532fbfaeda587e826d4cd5b21a49186f7c` revision as the metric tables.
They remain under OFL-1.1; the full copyright/licence is retained in
`src/metrics/data/LICENSE.OFL`. Their SHA-256 values match the metric manifest
and are checked before loading. No installed system fonts are read. The
validator and SVG-only builds do not include these original font binaries.

The following crates were added to the locked PNG dependency graph. Their exact
`.crate` archives were checked against the SHA-256 values in
`src-tauri/crates/Cargo.lock` before reading the package manifest and retaining
the selected license text. For multi-licensed crates, Maru selects MIT where
offered. Every retained file preserves the upstream copyright notice.

| Crate release | Selected license | Manifest `rust-version` | Retained notice |
| --- | --- | --- | --- |
| [arrayref 0.3.9](https://crates.io/crates/arrayref/0.3.9) | BSD-2-Clause | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/arrayref-BSD-2-Clause.txt` |
| [arrayvec 0.7.8](https://crates.io/crates/arrayvec/0.7.8) | MIT | 1.51 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/arrayvec-MIT.txt` |
| [bytemuck 1.25.2](https://crates.io/crates/bytemuck/1.25.2) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/bytemuck-MIT.txt` |
| [bytemuck_derive 1.12.1](https://crates.io/crates/bytemuck_derive/1.12.1) | MIT | 1.71 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/bytemuck_derive-MIT.txt` |
| [data-url 0.3.2](https://crates.io/crates/data-url/0.3.2) | MIT | 1.51 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/data-url-MIT.txt` |
| [euclid 0.22.14](https://crates.io/crates/euclid/0.22.14) | MIT | 1.63.0 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/euclid-MIT.txt` |
| [float-cmp 0.9.0](https://crates.io/crates/float-cmp/0.9.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/float-cmp-MIT.txt` |
| [font-types 0.12.7](https://crates.io/crates/font-types/0.12.7) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/font-types-MIT.txt` |
| [fontdb 0.24.0](https://crates.io/crates/fontdb/0.24.0) | MIT | 1.71 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/fontdb-MIT.txt` |
| [harfrust 0.12.0](https://crates.io/crates/harfrust/0.12.0) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/harfrust-MIT.txt` |
| [imagesize 0.15.0](https://crates.io/crates/imagesize/0.15.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/imagesize-MIT.txt` |
| [kurbo 0.13.1](https://crates.io/crates/kurbo/0.13.1) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/kurbo-MIT.txt` |
| [pico-args 0.5.0](https://crates.io/crates/pico-args/0.5.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/pico-args-MIT.txt` |
| [polycool 0.4.0](https://crates.io/crates/polycool/0.4.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/polycool-MIT.txt` |
| [read-fonts 0.41.0](https://crates.io/crates/read-fonts/0.41.0) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/read-fonts-MIT.txt` |
| [resvg 0.49.0](https://crates.io/crates/resvg/0.49.0) | MIT | 1.85.0 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/resvg-MIT.txt` |
| [rgb 0.8.53](https://crates.io/crates/rgb/0.8.53) | MIT | 1.64 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/rgb-MIT.txt` |
| [simplecss 0.2.2](https://crates.io/crates/simplecss/0.2.2) | MIT | 1.65 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/simplecss-MIT.txt` |
| [skrifa 0.44.0](https://crates.io/crates/skrifa/0.44.0) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/skrifa-MIT.txt` |
| [slotmap 1.1.1](https://crates.io/crates/slotmap/1.1.1) | Zlib | 1.58.0 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/slotmap-Zlib.txt` |
| [strict-num 0.1.1](https://crates.io/crates/strict-num/0.1.1) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/strict-num-MIT.txt` |
| [svgtypes 0.16.2](https://crates.io/crates/svgtypes/0.16.2) | MIT | 1.85 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/svgtypes-MIT.txt` |
| [tiny-skia 0.12.0](https://crates.io/crates/tiny-skia/0.12.0) | BSD-3-Clause | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/tiny-skia-BSD-3-Clause.txt` |
| [tiny-skia-path 0.12.0](https://crates.io/crates/tiny-skia-path/0.12.0) | BSD-3-Clause | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/tiny-skia-path-BSD-3-Clause.txt` |
| [unicode-bidi 0.3.18](https://crates.io/crates/unicode-bidi/0.3.18) | MIT | 1.47.0 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/unicode-bidi-MIT.txt` |
| [unicode-script 0.5.9](https://crates.io/crates/unicode-script/0.5.9) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/unicode-script-MIT.txt` |
| [unicode-vo 0.1.0](https://crates.io/crates/unicode-vo/0.1.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/unicode-vo-MIT.txt` |
| [usvg 0.49.0](https://crates.io/crates/usvg/0.49.0) | MIT | 1.85.0 | `src-tauri/crates/maru-diagram-engine/src/render/licenses/resvg-MIT.txt` |
| [xmlwriter 0.1.0](https://crates.io/crates/xmlwriter/0.1.0) | MIT | not declared | `src-tauri/crates/maru-diagram-engine/src/render/licenses/xmlwriter-MIT.txt` |

The highest declared Rust MSRV in these manifests is 1.85.0, below the engine's
1.90.0 MSRV. `not declared` means the exact manifest has no `rust-version`
field; no MSRV is inferred for those crates.
