import { SitesPane } from "../../components/sites/SitesPane";
import type { ModeAdapterProps } from "../modeRegistry";
import { useSitesModeSlice, visualModeController } from "../visualModeStore";

/** Dedicated lazy Sites surface; native open intents stay in the visual-mode store. */
export function SitesModeAdapter({ commands }: ModeAdapterProps) {
  const sites = useSitesModeSlice();
  return (
    <SitesPane
      overlayOpen={commands.sitesOverlayOpen ?? false}
      onEmptyClose={commands.closeRightWorkbench}
      openedUrls={sites.openedUrls}
      onOpenedUrlsHandled={visualModeController.acknowledgeSiteUrls}
    />
  );
}
