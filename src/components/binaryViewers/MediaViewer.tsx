import { assetUrlForPath } from "../../lib/binaryViewer";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  kind: "audio" | "video";
}

export function MediaViewer({ entry, kind }: Props) {
  const url = assetUrlForPath(entry.path);
  return (
    <div className={`binary-viewer binary-viewer--${kind}`}>
      <div className="binary-viewer-canvas binary-viewer-canvas--media">
        {kind === "audio" ? (
          <audio key={url} controls src={url} preload="metadata" />
        ) : (
          <video key={url} controls src={url} preload="metadata" playsInline />
        )}
      </div>
    </div>
  );
}
