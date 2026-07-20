import type { CandidatePool } from './candidates.js';
import { parseEntityRecallInput } from './entity-hypotheses.js';
import {
  recallFromEntity,
  type EntityRecallNcmClient
} from './entity-recall.js';
import {
  filterWebDiscoveryHintsForRecall as filterWebDiscoveryHintsByPolicy
} from './web-discovery-hints.js';
import { selectWebDiscoveryStyle } from './web-discovery-planning.js';
import type {
  MusicAgentContextSummary,
  QueryPlan
} from './schema.js';

const DEFAULT_ENTITY_SEARCH_LIMIT = 3;
const MAX_ENTITY_RECALL_COUNT = 8;

export type WebHintRecallOptions = {
  hints: unknown;
  ncmClient: EntityRecallNcmClient;
  candidatePool: CandidatePool;
  context: MusicAgentContextSummary;
  queryPlan: QueryPlan | null;
  consumeNcmSearch: () => boolean;
  consumePlaylistFetch: () => boolean;
  signal?: AbortSignal;
  limit: number;
};

export type WebHintRecallResult = {
  summary: string;
  problems: string[];
  aborted?: boolean;
};

export async function recallFromWebDiscoveryHints(options: WebHintRecallOptions): Promise<WebHintRecallResult> {
  const filteredHints = filterWebDiscoveryHintsForRecall(options.hints, options);
  const parsedInput = parseEntityRecallInput({ hints: filteredHints.hints });
  const entities = parsedInput.entities.slice(0, MAX_ENTITY_RECALL_COUNT);
  const problems = [...filteredHints.problems, ...parsedInput.problems];
  let added = 0;

  for (const entity of entities) {
    if (options.signal?.aborted) return { summary: 'web hint entity recall aborted.', problems: ['aborted'], aborted: true };
    const result = await recallFromEntity({
      entity,
      ncmClient: options.ncmClient,
      candidatePool: options.candidatePool,
      context: options.context,
      limit: options.limit,
      searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
      consumeNcmSearch: options.consumeNcmSearch,
      consumePlaylistFetch: options.consumePlaylistFetch,
      provenanceKind: 'web_hint_recall',
      signal: options.signal
    });
    added += result.added;
    problems.push(...result.problems);
  }

  return {
    summary: `web hint entity recall added ${added} candidates from ${entities.length} entities.`,
    problems
  };
}

function filterWebDiscoveryHintsForRecall(
  value: unknown,
  input: Pick<WebHintRecallOptions, 'context' | 'queryPlan'>
): { hints: unknown[]; problems: string[] } {
  const expectedStyle = selectWebDiscoveryStyle(input.context, input.queryPlan);
  return filterWebDiscoveryHintsByPolicy(value, { expectedStyle });
}
