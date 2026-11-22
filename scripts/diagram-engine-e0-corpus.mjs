// E0 corpus intake helpers. The live Archify oracle that generated
// `parity.json` was removed in maru#554 E6 T2; its verdicts are frozen in the
// corpus (see `frozenOracle` there and docs/diagram.md, Frozen oracle). New
// corpus cases are labelled by the Maru engine and reviewed in a PR, so only
// the privacy and evidence-stripping rules that still guard intake remain.
const privateText = /(?:(?:^|[\s"'(=])\/(?:Users|home|raid|private|tmp)\/|(?:^|[\s"'(])[A-Za-z]:[\\/]|~[\\/]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;

/** True when `text` holds a local path, contact data or one of `extraTerms`.
 * @param {string} text @param {string[]} [extraTerms] */
export function hasPrivateText(text, extraTerms = []) {
  return privateText.test(text) || extraTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}

/** A copy of `spec` without machine-bound repository evidence.
 * @param {Record<string, any>} spec @param {string} diagramType */
export function withoutRepositoryEvidence(spec, diagramType) {
  const clean = structuredClone(spec);
  if (clean.meta) delete clean.meta.repository;
  const collection = { architecture: "components", workflow: "nodes", sequence: "participants", dataflow: "nodes", lifecycle: "states" }[diagramType];
  for (const node of clean[collection] ?? []) if (node && typeof node === "object") delete node.sources;
  return clean;
}
