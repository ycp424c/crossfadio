import type { CandidatePool } from './candidates.js';
import { entityFromStoredRecord } from './entity-hypotheses.js';
import {
  recallFromEntity,
  type EntityRecallOptions,
  type EntityRecallNcmClient
} from './entity-recall.js';
import {
  findSimilarMusicEntities
} from '../store/music-entities.js';
import type {
  MusicAgentContextSummary,
  QueryPlan
} from './schema.js';

const DEFAULT_SEMANTIC_ENTITY_LIMIT = 8;
const DEFAULT_ENTITY_SEARCH_LIMIT = 3;

export type MusicAgentEmbeddingClient = {
  embed: (
    input: string | string[],
    opts?: { signal?: AbortSignal }
  ) => Promise<{ vectors: Float32Array[]; model: string; dimensions: number }>;
};

export type SemanticEntityRecallOptions = {
  semanticQueries: string[];
  userId: string;
  ncmClient: EntityRecallNcmClient;
  candidatePool: CandidatePool;
  context: MusicAgentContextSummary;
  queryPlan: QueryPlan | null;
  embeddingClient?: MusicAgentEmbeddingClient | null;
  embeddingModel?: string | null;
  consumeNcmSearch: () => boolean;
  consumePlaylistFetch: () => boolean;
  sourceReservoir?: EntityRecallOptions['sourceReservoir'];
  signal?: AbortSignal;
  limit: number;
};

export type SemanticEntityRecallResult = {
  attempted: boolean;
  added: number;
  matchCount: number;
  problems: string[];
  fetchedSourceCount?: number;
};

export async function recallFromSemanticEntities(
  options: SemanticEntityRecallOptions
): Promise<SemanticEntityRecallResult> {
  if (!options.embeddingClient || !options.embeddingModel) {
    return {
      attempted: false,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery unavailable: embedding client is not configured']
    };
  }

  const text = uniqueStrings([
    ...options.semanticQueries,
    ...(options.queryPlan?.styleHints ?? []),
    ...(options.queryPlan?.listeningConstraints ?? []),
    options.context.currentUserText,
    options.context.activeDirective,
    options.context.tasteSummary,
    options.context.recentPreferenceSummary
  ]).join(' ');
  if (!text) {
    return {
      attempted: false,
      added: 0,
      matchCount: 0,
      problems: ['semantic discovery skipped: empty intent text']
    };
  }

  try {
    const embedding = await options.embeddingClient.embed(text, { signal: options.signal });
    if (options.signal?.aborted) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['aborted'] };
    }
    const vector = embedding.vectors[0];
    if (!vector || vector.length === 0) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['semantic discovery returned no embedding vector'] };
    }

    const matches = findSimilarMusicEntities({
      userId: options.userId,
      model: options.embeddingModel,
      vector,
      limit: DEFAULT_SEMANTIC_ENTITY_LIMIT
    });
    if (matches.length === 0) {
      return { attempted: true, added: 0, matchCount: 0, problems: ['semantic discovery found no indexed entities'] };
    }

    const problems: string[] = [];
    let added = 0;
    let fetchedSourceCount = 0;

    for (const match of matches) {
      if (options.signal?.aborted) {
        return { attempted: true, added, matchCount: matches.length, problems: ['aborted'] };
      }
      const entity = entityFromStoredRecord(match.entity);
      if (!entity) {
        problems.push(`semantic entity skipped: unsupported type ${match.entity.type}`);
        continue;
      }
      const result = await recallFromEntity({
        entity,
        ncmClient: options.ncmClient,
        candidatePool: options.candidatePool,
        context: options.context,
        limit: options.limit,
        searchLimit: DEFAULT_ENTITY_SEARCH_LIMIT,
        consumeNcmSearch: options.consumeNcmSearch,
        consumePlaylistFetch: options.consumePlaylistFetch,
        provenanceKind: 'semantic_discovery',
        sourceReservoir: options.sourceReservoir,
        signal: options.signal
      });
      added += result.added;
      fetchedSourceCount += result.fetchedSourceCount ?? 0;
      problems.push(...result.problems);
      if (added >= options.limit) break;
    }

    return {
      attempted: true,
      added,
      matchCount: matches.length,
      problems,
      ...(options.sourceReservoir ? { fetchedSourceCount } : {})
    };
  } catch (error) {
    return {
      attempted: true,
      added: 0,
      matchCount: 0,
      problems: [`semantic discovery failed: ${formatError(error)}`]
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
