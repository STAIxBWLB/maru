import { CatalogPane } from "../../components/catalog/CatalogPane";
import { useCatalogModeSlice } from "../documentOpsModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Catalog surface retaining its document-ops controller contract. */
export function CatalogModeAdapter(_props: ModeAdapterProps) {
  const catalog = useCatalogModeSlice();
  return catalog.host ? <CatalogPane {...catalog.host} /> : null;
}
