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
and `NOTICE.md` within the engine crate. The source SHA-256 and units-per-em are
recorded alongside each path. Original font binaries are remote test fixtures,
not embedded in the validator or SVG. Supported scalars reference the Noto font
family with shaping disabled; unsupported scalars draw the actual glyph zero.
