import type { InboxSourceChannel } from "../../lib/inboxSources";
import type { MissionProgress } from "../../lib/missionProgress";
import type { InboxSourceRun } from "../../lib/types";
import { SourceHeaderCard } from "./SourceHeaderCard";

interface AllSourcesOverviewProps {
  channels: InboxSourceChannel[];
  runByChannel: Map<string, InboxSourceRun>;
  processedByChannel: Map<string, number>;
  runningChannels: Set<string>;
  progressByChannel: Map<string, MissionProgress>;
  actionBusy: boolean;
  onProcessNow: (channel: string) => void;
  onSelect: (channel: string) => void;
}

export function AllSourcesOverview({
  channels,
  runByChannel,
  processedByChannel,
  runningChannels,
  progressByChannel,
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
          progress={progressByChannel.get(channel) ?? null}
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
