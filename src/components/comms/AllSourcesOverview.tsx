import type { InboxSourceChannel } from "../../lib/inboxSources";
import type { InboxSourceRun } from "../../lib/types";
import { SourceHeaderCard } from "./SourceHeaderCard";

interface AllSourcesOverviewProps {
  channels: InboxSourceChannel[];
  runByChannel: Map<string, InboxSourceRun>;
  processedByChannel: Map<string, number>;
  runningChannels: Set<string>;
  actionBusy: boolean;
  onProcessNow: (channel: string) => void;
  onSelect: (channel: string) => void;
}

export function AllSourcesOverview({
  channels,
  runByChannel,
  processedByChannel,
  runningChannels,
  actionBusy,
  onProcessNow,
  onSelect,
}: AllSourcesOverviewProps) {
  return (
    <div className="comms-source-grid">
      {channels.map((channel) => (
        <SourceHeaderCard
          key={channel}
          channel={channel}
          run={runByChannel.get(channel) ?? null}
          running={runningChannels.has(channel)}
          processedCount={processedByChannel.get(channel) ?? 0}
          actionBusy={actionBusy}
          compact
          onProcessNow={onProcessNow}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
