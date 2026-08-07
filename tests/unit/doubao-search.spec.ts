import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { isSearchConfigured, searchHotTopics } from '../../src/server/doubao-search';

const originalEnv = { ...process.env };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

beforeEach(() => {
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  process.env.CROSSFADIO_SEARCH_API_KEY = 'test-search-key';
  resetConfigForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetConfigForTest();
});

describe('doubao search client', () => {
  it('posts to the web_search endpoint with bearer auth and parses WebResults', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ResponseMetadata: {},
        Result: {
          WebResults: [
            {
              Title: '某歌手发布新专辑',
              Url: 'https://example.com/a',
              SiteName: '娱乐周刊',
              PublishTime: '2026-08-07T09:00:00+08:00',
              Content: '正文内容'.repeat(200)
            },
            { Title: '另一条新闻', Summary: '只有摘要' },
            { Title: '第三条', Snippet: '只有片段' },
            { Title: '' },
            { Title: 123 }
          ]
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const topics = await searchHotTopics('今日热点', { count: 5 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-search-key');
    expect(JSON.parse(String(init.body))).toEqual({ Query: '今日热点', SearchType: 'web', Count: 5, TimeRange: 'OneDay' });

    expect(topics).toHaveLength(3);
    expect(topics?.[0]).toMatchObject({
      title: '某歌手发布新专辑',
      siteName: '娱乐周刊',
      publishTime: '2026-08-07T09:00:00+08:00'
    });
    expect(topics?.[0].summary.length).toBeLessThanOrEqual(200);
    expect(topics?.[1].summary).toBe('只有摘要');
    expect(topics?.[2].summary).toBe('只有片段');
  });

  it('drops results with a clearly stale publish time but keeps undated ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        ResponseMetadata: {},
        Result: {
          WebResults: [
            { Title: '三天前的旧闻', PublishTime: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
            { Title: '今天的新闻', PublishTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
            { Title: '没有日期的结果' },
            { Title: '日期无法解析', PublishTime: 'not-a-date' }
          ]
        }
      })
    ));

    const topics = await searchHotTopics('今日热点');

    expect(topics?.map((t) => t.title)).toEqual(['今天的新闻', '没有日期的结果', '日期无法解析']);
  });

  it('returns null on API business error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ResponseMetadata: { Error: { Code: 'InvalidParameter', Message: 'bad query' } } })
    ));

    await expect(searchHotTopics('x')).resolves.toBeNull();
  });

  it('returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));

    await expect(searchHotTopics('x')).resolves.toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network down'))));

    await expect(searchHotTopics('x')).resolves.toBeNull();
  });

  it('returns null without calling fetch when the API key is not configured', async () => {
    delete process.env.CROSSFADIO_SEARCH_API_KEY;
    resetConfigForTest();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isSearchConfigured()).toBe(false);
    await expect(searchHotTopics('x')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
