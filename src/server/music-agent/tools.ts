import type { MusicAgentToolName } from './schema.js';

export type ToolObservation = {
  summary: string;
  candidateCount: number;
  problems?: string[];
};

export type MusicAgentTool = (
  input: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<ToolObservation>;

export type MusicAgentToolRegistry = Partial<Record<MusicAgentToolName, MusicAgentTool>>;
