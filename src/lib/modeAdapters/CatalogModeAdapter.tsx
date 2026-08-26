import { CatalogPane } from "../../components/catalog/CatalogPane";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Catalog surface retaining its workspace-root and reveal contract. */
export function CatalogModeAdapter({ commands }: ModeAdapterProps) {
  const catalog = commands.documentOps?.catalog;
  return catalog ? <CatalogPane {...catalog} /> : null;
}
