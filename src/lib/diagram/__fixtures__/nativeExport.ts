/** Fixed, public, path-free semantic source for the native export regression. */
export const NATIVE_EXPORT_SPEC = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Native static export 한日中", output: "native-static-export.html", locale: "en" },
  layout: { mode: "grid" },
  components: [{ id: "native_app", type: "backend", label: "한日中", row: 0, col: 0 }],
  boundaries: [],
  connections: [],
};
