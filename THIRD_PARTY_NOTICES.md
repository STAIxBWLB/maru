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
