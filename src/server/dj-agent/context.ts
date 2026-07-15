import type { NcmClient } from '../ncm/client.js';
import { buildMusicAgentContext } from '../music-agent/context.js';
import type { MusicAgentContextSummary, MusicAgentRuntimeContext } from '../music-agent/schema.js';
import { getRecentDjEvents, type DjEventRecord } from '../store/dj-events.js';

export type DjContextSnapshot = {
  userId: string;
  createdAt: string;
  recentEvents: DjEventRecord[];
  musicSelectionContext: MusicAgentRuntimeContext;
  personalDjContext: MusicAgentContextSummary['personalDjContext'] | null;
};

export type BuildDjContextSnapshotInput = {
  userId: string;
  ncmClient?: NcmClient;
  includeDailyTheme?: boolean;
  now?: Date;
  recentEventLimit?: number;
};

export async function buildDjContextSnapshot(
  input: BuildDjContextSnapshotInput
): Promise<DjContextSnapshot> {
  const now = input.now ?? new Date();
  const musicSelectionContext = await buildMusicAgentContext({
    userId: input.userId,
    ncmClient: input.ncmClient,
    request: 'auto-fill',
    includeDailyTheme: input.includeDailyTheme,
    now
  });

  return {
    userId: input.userId,
    createdAt: now.toISOString(),
    recentEvents: getRecentDjEvents(input.userId, input.recentEventLimit ?? 50),
    musicSelectionContext,
    personalDjContext: musicSelectionContext.personalDjContext ?? null
  };
}
