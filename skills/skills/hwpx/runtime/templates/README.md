# HWPX Templates

Place editable HWPX template files here using the document template id as the file name.

Examples:

- `report.hwpx`
- `gongmun.hwpx`
- `minutes.hwpx`
- `proposal.hwpx`
- `notice.hwpx`

The exporter preserves the original HWPX layout and fills common placeholders such as
`{{TITLE}}`, `{{BODY}}`, `{{보고일자}}`, `{{보고부서}}`, `{{보고자}}`, and table cells next to
labels like `보고일자`, `보고부서`, `보고자`, `수신`, `참조`, `장소`.

If a matching template file is not present, the app falls back to the existing HTML to HWPX
conversion path.
