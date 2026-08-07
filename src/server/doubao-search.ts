import { getConfig } from './config.js';
import { getLogger } from './logger.js';

// 豆包搜索 Custom 版（火山引擎）：POST open.feedcoopapi.com/search_api/web_search
// 文档：https://www.volcengine.com/docs/87772/2272953

export type HotTopic = {
  title: string;
  siteName: string | null;
  publishTime: string | null;
  summary: string;
};

const SEARCH_ENDPOINT = 'https://open.feedcoopapi.com/search_api/web_search';
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_COUNT = 8;
const MAX_SUMMARY_CHARS = 200;
// TimeRange=OneDay 由服务端过滤；这里再做一层客户端兜底，容忍时区/时钟偏差
const MAX_TOPIC_AGE_MS = 36 * 60 * 60 * 1000;

type WebResult = {
  Title?: unknown;
  Url?: unknown;
  SiteName?: unknown;
  PublishTime?: unknown;
  Content?: unknown;
  Summary?: unknown;
  Snippet?: unknown;
};

type SearchResponse = {
  ResponseMetadata?: {
    Error?: { Code?: unknown; Message?: unknown };
  };
  Result?: {
    WebResults?: WebResult[];
  };
};

export function isSearchConfigured(): boolean {
  return Boolean(getConfig().search?.apiKey);
}

/**
 * 豆包搜索热榜/新闻。任何失败（未配置、网络、超时、业务错误）都返回 null，
 * 调用方按"无实时热点"降级，不能让搜索拖垮主流程。
 */
export async function searchHotTopics(
  query: string,
  opts: { count?: number; timeoutMs?: number } = {}
): Promise<HotTopic[] | null> {
  const apiKey = getConfig().search?.apiKey;
  if (!apiKey) return null;

  const logger = getLogger();
  const timeoutMs = opts.timeoutMs ?? getSearchTimeoutMs();
  const count = opts.count ?? DEFAULT_COUNT;

  try {
    const resp = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ Query: query, SearchType: 'web', Count: count, TimeRange: 'OneDay' }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'Doubao search: HTTP error');
      return null;
    }

    const data = (await resp.json()) as SearchResponse;
    const bizError = data.ResponseMetadata?.Error;
    if (bizError) {
      logger.warn({ code: bizError.Code, message: bizError.Message }, 'Doubao search: API error');
      return null;
    }

    const results = data.Result?.WebResults;
    if (!Array.isArray(results) || results.length === 0) return null;

    const topics: HotTopic[] = [];
    for (const r of results) {
      const title = typeof r.Title === 'string' ? r.Title.trim() : '';
      if (!title) continue;
      const publishTime = typeof r.PublishTime === 'string' && r.PublishTime.trim() ? r.PublishTime.trim() : null;
      if (isStale(publishTime)) continue;
      const rawSummary = [r.Content, r.Summary, r.Snippet].find(
        (v): v is string => typeof v === 'string' && v.trim().length > 0
      );
      topics.push({
        title,
        siteName: typeof r.SiteName === 'string' && r.SiteName.trim() ? r.SiteName.trim() : null,
        publishTime,
        summary: rawSummary ? rawSummary.trim().slice(0, MAX_SUMMARY_CHARS) : ''
      });
    }

    return topics.length > 0 ? topics : null;
  } catch (err) {
    logger.warn({ err }, 'Doubao search: request failed');
    return null;
  }
}

/** 发布时间明确且超过窗口期 → 旧闻，丢弃；无法解析时间的保留（服务端已按 OneDay 过滤） */
function isStale(publishTime: string | null): boolean {
  if (!publishTime) return false;
  const publishedAt = Date.parse(publishTime);
  if (!Number.isFinite(publishedAt)) return false;
  return Date.now() - publishedAt > MAX_TOPIC_AGE_MS;
}

function getSearchTimeoutMs(): number {
  const raw = Number(process.env.CROSSFADIO_SEARCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}
