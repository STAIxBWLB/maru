// Record hwp-editor's form wire parsers on a fixed corpus for the maru host
// port (maru#626 T126-R2/R4). Usage:
//   node scripts/record-hwped-form-parity.mjs <bundled upstream forms.mjs> [real-artifacts.json] \
//     > src-tauri/src/hwped/forms/parity.json
// Each row is { fn, input, plan?, ok, output | path }, where `path` is the JSON
// path from upstream's "Invalid form data at <path>". Never edit the output.
const [, , modulePath] = process.argv;
const up = await import(modulePath);

const H = (c) => c.repeat(64);
const OCC = (c) => `occ-${c.repeat(64)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const set = (base, mutate) => { const x = clone(base); mutate(x); return x; };

const occ = {
  id: OCC("a"), kind: "cell_text", label: "성명", paragraph_id: "p.0", section: 0, indices: [1, 0],
  model_route: "s0/p1", table_id: "t0", table_index: 0, row: 1, col: 2, start: 0, end: 2,
  old_text: "AB", prior_sha256: H("b"), bindable: true, cause: null, next_step: null,
  label_occurrences: 1, label_ambiguous: false,
};
const unbound = { ...occ, id: OCC("c"), bindable: false, cause: "rich_target", next_step: "edit by hand" };
const native = { ...occ, id: OCC("d"), kind: "native_field", bindable: false, cause: "native_field", next_step: "hwp fields" };
const discovery = { version: 1, source_sha256: H("1"), structural_sha256: H("2"), occurrences: [occ, unbound, native] };

const discoveries = [
  discovery,
  { ...discovery, occurrences: [] },
  set(discovery, (x) => { x.extra = 1; }),
  set(discovery, (x) => { delete x.occurrences; }),
  set(discovery, (x) => { x.version = 2; }),
  set(discovery, (x) => { x.version = 1.0; }),
  set(discovery, (x) => { x.source_sha256 = H("A"); }),
  set(discovery, (x) => { x.source_sha256 = "1".repeat(63); }),
  set(discovery, (x) => { x.occurrences[0].secret = "/Users/me/x"; }),
  set(discovery, (x) => { x.occurrences[0].id = "occ-xyz"; }),
  set(discovery, (x) => { x.occurrences[0].kind = "other"; }),
  set(discovery, (x) => { x.occurrences[0].cause = "rich_target"; }),
  set(discovery, (x) => { x.occurrences[1].next_step = null; }),
  set(discovery, (x) => { x.occurrences[1].next_step = ""; }),
  set(discovery, (x) => { x.occurrences[1].cause = "other"; }),
  set(discovery, (x) => { x.occurrences[2].next_step = "something"; }),
  set(discovery, (x) => { x.occurrences[0].start = 3; }),
  set(discovery, (x) => { x.occurrences[0].label = ""; }),
  set(discovery, (x) => { x.occurrences[0].label = ""; x.occurrences[0].label_occurrences = 0; }),
  set(discovery, (x) => { x.occurrences[0].label_occurrences = 2; }),
  set(discovery, (x) => { x.occurrences[0].label_occurrences = 2; x.occurrences[0].label_ambiguous = true; }),
  set(discovery, (x) => { x.occurrences[0].row = 65536; }),
  set(discovery, (x) => { x.occurrences[0].row = -1; }),
  set(discovery, (x) => { x.occurrences[0].section = 1.5; }),
  set(discovery, (x) => { x.occurrences[0].section = 2.0; }),
  set(discovery, (x) => { x.occurrences[0].indices = Array(33).fill(0); }),
  set(discovery, (x) => { x.occurrences[0].paragraph_id = ""; }),
  set(discovery, (x) => { x.occurrences[0].paragraph_id = null; x.occurrences[0].table_id = null; x.occurrences[0].table_index = null; x.occurrences[0].row = null; x.occurrences[0].col = null; }),
  set(discovery, (x) => { x.occurrences[0].model_route = ""; }),
  set(discovery, (x) => { x.occurrences[0].prior_sha256 = "zz"; }),
  set(discovery, (x) => { x.occurrences[1].id = OCC("a"); }),
  "not an object",
  null,
  [],
];

const target = { occurrence_id: OCC("a"), max_chars: 10, allow_reflow: false };
const plan = { version: 1, source_sha256: H("1"), structural_sha256: H("2"), bindings: [{ key: "name", targets: [target] }] };
const plans = [
  plan,
  set(plan, (x) => { x.bindings[0].targets[0].copies = [0, 3]; }),
  set(plan, (x) => { x.bindings[0].targets[0].copies = []; }),
  set(plan, (x) => { x.bindings[0].targets[0].copies = [1, 1]; }),
  set(plan, (x) => { x.bindings[0].targets[0].copies = [16]; }),
  set(plan, (x) => { x.bindings[0].targets[0].receipt = "/tmp/r.json"; }),
  set(plan, (x) => { x.receipt = "/private/escape.json"; }),
  set(plan, (x) => { x.bindings[0].extra = true; }),
  set(plan, (x) => { x.bindings[0].targets[0].max_chars = 0; }),
  set(plan, (x) => { x.bindings[0].targets[0].max_chars = 20001; }),
  set(plan, (x) => { x.bindings[0].targets[0].allow_reflow = "yes"; }),
  set(plan, (x) => { x.bindings[0].targets[0].occurrence_id = ""; }),
  set(plan, (x) => { x.bindings[0].targets = []; }),
  set(plan, (x) => { x.bindings = []; }),
  set(plan, (x) => { x.bindings[0].key = ""; }),
  set(plan, (x) => { x.bindings[0].key = "k".repeat(129); }),
  set(plan, (x) => { x.bindings.push(clone(x.bindings[0])); }),
  set(plan, (x) => { x.bindings.push({ key: "other", targets: [clone(target)] }); }),
  set(plan, (x) => { x.structural_sha256 = "short"; }),
  set(plan, (x) => { x.version = 2; }),
  set(plan, (x) => { x.repeats = [{ table_id: "t0", after_paragraph_id: "p.1", copies: 2, profile_ids: ["a", "b"] }]; }),
  set(plan, (x) => { x.repeats = [{ table_id: "t0", after_paragraph_id: "p.1", copies: 2, profile_ids: ["a"] }]; }),
  set(plan, (x) => { x.repeats = [{ table_id: "t0", after_paragraph_id: "p.1", copies: 2, profile_ids: ["a", "a"] }]; }),
  set(plan, (x) => { x.constraints = [{ kind: "equal", left: "name", right: "name" }]; }),
  set(plan, (x) => { x.constraints = [{ kind: "sum", keys: [], total: "name" }]; }),
  set(plan, (x) => { x.constraints = [{ kind: "other" }]; }),
  set(plan, (x) => { x.constraints = [{ kind: "equal", left: "name", right: "name", note: 1 }]; }),
  [],
  null,
];

const numericPlan = { ...plan, bindings: [
  { key: "a", targets: [{ occurrence_id: OCC("a"), max_chars: 30, allow_reflow: true }] },
  { key: "b", targets: [{ occurrence_id: OCC("c"), max_chars: 30, allow_reflow: true }] },
  { key: "t", targets: [{ occurrence_id: OCC("e"), max_chars: 30, allow_reflow: true }] },
], constraints: [{ kind: "sum", keys: ["a", "b"], total: "t" }] };
const valueCases = [
  [plan, { name: "Lee" }],
  [plan, { name: "" }],
  [plan, { name: "가나다라마바사아자차" }],
  [plan, { name: "가나다라마바사아자차카" }],
  [plan, { name: "tab\tand\nnewline" }],
  [plan, { name: "bell\u0007" }],
  [plan, { name: 3 }],
  [plan, {}],
  [plan, { name: "x", extra: "y" }],
  [plan, ["x"]],
  [numericPlan, { a: "1,000", b: "234", t: "1234" }],
  [numericPlan, { a: "1", b: "2", t: "4" }],
  [numericPlan, { a: "1,00", b: "2", t: "3" }],
  [numericPlan, { a: "x", b: "2", t: "3" }],
  [numericPlan, { a: "9223372036854775807", b: "0", t: "9223372036854775807" }],
  [numericPlan, { a: "9223372036854775807", b: "1", t: "1" }],
  [numericPlan, { a: "9223372036854775808", b: "0", t: "0" }],
];

const receipt = {
  version: 1, source_sha256: H("1"), plan_sha256: H("3"), values_sha256: H("4"), output_sha256: H("5"),
  published: false, occurrence_ids: [OCC("a")], targets: 1, cloned_profiles: 0,
  semantic_budget: "selected_text_and_declared_clones_only", render_font_native: "unverified", native_warning_count: 1,
};
const receipts = [
  receipt,
  set(receipt, (x) => { x.published = true; }),
  set(receipt, (x) => { x.engine_path = "/Users/me/.ahwp"; }),
  set(receipt, (x) => { delete x.output_sha256; }),
  set(receipt, (x) => { x.occurrence_ids = ["bad"]; }),
  set(receipt, (x) => { x.semantic_budget = "everything"; }),
  set(receipt, (x) => { x.render_font_native = "verified"; }),
  set(receipt, (x) => { x.targets = -1; }),
  set(receipt, (x) => { x.native_warning_count = 1.5; }),
];

const change = {
  occurrence_id: OCC("a"), copy: 0, profile_id: null, paragraph_id: "p.0", section: 0, indices: [1],
  row: null, col: null, start: 0, end: 2, old_text: "AB", new_text: "Lee", max_chars: 10, allow_reflow: true,
};
const preview = {
  version: 1, source_sha256: H("1"), plan_sha256: H("3"), values_sha256: H("4"),
  copies: [{ source_table_id: "t0", copy: 1, profile_id: "a", table_id: "t1", section: 0, indices: [2] }],
  changes: [change],
  native_warnings: ["font fallback while reading /Users/홍길동/Library/Fonts/x.ttf", "C:\\Users\\me\\doc.hwpx"],
};
const previews = [
  preview,
  set(preview, (x) => { x.native_warnings = []; }),
  set(preview, (x) => { x.native_warnings = [3]; }),
  set(preview, (x) => { x.native_warnings = "one"; }),
  set(preview, (x) => { x.changes[0].staged = "/var/folders/x/out.hwpx"; }),
  set(preview, (x) => { x.changes[0].new_text = "x".repeat(11); }),
  set(preview, (x) => { x.changes[0].new_text = "nul\u0000"; }),
  set(preview, (x) => { x.changes[0].copy = 16; }),
  set(preview, (x) => { x.changes[0].start = 5; }),
  set(preview, (x) => { x.changes[0].occurrence_id = "occ-1"; }),
  set(preview, (x) => { x.changes[0].profile_id = "p"; x.changes[0].row = 3; x.changes[0].col = 70000; }),
  set(preview, (x) => { x.copies[0].copy = -1; }),
  set(preview, (x) => { x.copies[0].note = "x"; }),
  set(preview, (x) => { delete x.copies; }),
];

const rows = [];
function record(fn, call, input, extra = {}) {
  try {
    rows.push({ fn, input, ...extra, ok: true, output: call() });
  } catch (error) {
    const path = /^Invalid form data at (.*)$/.exec(error.message)?.[1];
    if (path === undefined) throw error;
    rows.push({ fn, input, ...extra, ok: false, path });
  }
}
for (const input of discoveries) record("discovery", () => up.parseFormDiscovery(input), input);
for (const input of plans) record("plan", () => up.parseFormBindingPlan(input), input);
for (const [p, input] of valueCases) {
  const parsed = up.parseFormBindingPlan(p);
  record("values", () => up.validateFormValues(parsed, input), input, { plan: parsed });
}
for (const input of receipts) record("receipt", () => up.parseFormReceipt(input), input);
for (const input of previews) record("preview", () => up.parseFormPreview(input), input);
// Optional: a JSON file of artifacts the released engine wrote, as
// { discovery, receipt, preview }, so real engine output is in the corpus too.
const real = process.argv[3];
if (real) {
  const { readFileSync } = await import("node:fs");
  const artifacts = JSON.parse(readFileSync(real, "utf8"));
  record("discovery", () => up.parseFormDiscovery(artifacts.discovery), artifacts.discovery, { source: "ahwp 2.0.0" });
  record("receipt", () => up.parseFormReceipt(artifacts.receipt), artifacts.receipt, { source: "ahwp 2.0.0" });
  record("preview", () => up.parseFormPreview(artifacts.preview), artifacts.preview, { source: "ahwp 2.0.0" });
}
process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
