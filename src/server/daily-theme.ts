import { resolveLlmConfig } from './llm/config.js';
import { LlmClient, type LlmMessage } from './llm/client.js';
import { getLogger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DailyTheme = {
  date: string; // YYYY-MM-DD
  theme: string;
  keywords: string[];
  generatedAt: number;
};

// ── Runtime state (shared across all users) ──────────────────────────────────

let themeCache: DailyTheme | null = null;
let generatingPromise: Promise<DailyTheme | null> | null = null;

const DEFAULT_GENERATION_TIMEOUT_MS = 15_000;

export function _resetForTest(): void {
  themeCache = null;
  generatingPromise = null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Synchronous: returns cached theme or null. Does not trigger generation. */
export function getDailyTheme(): DailyTheme | null {
  const today = formatDate(new Date());
  if (themeCache && themeCache.date === today) {
    return themeCache;
  }
  return null;
}

/**
 * Async: returns cached theme, or triggers generation (deduplicated).
 * The first caller on a new day triggers generation; concurrent callers
 * await the same promise. Subsequent calls on the same day return the cache.
 */
export async function getOrGenerateDailyTheme(): Promise<DailyTheme | null> {
  const today = formatDate(new Date());

  // Cache hit
  if (themeCache && themeCache.date === today) {
    return themeCache;
  }

  // Already generating — join the in-flight promise
  if (generatingPromise) {
    return generatingPromise;
  }

  // Start async generation (not awaited by original caller in DJ path,
  // but this promise is stored so concurrent callers await it)
  generatingPromise = generateTheme(today).finally(() => {
    generatingPromise = null;
  });

  return generatingPromise;
}

export async function getOrGenerateDailyThemeWithin(timeoutMs: number): Promise<DailyTheme | null> {
  return withTimeout(getOrGenerateDailyTheme(), timeoutMs, getDailyTheme());
}

// ── Theme generation ─────────────────────────────────────────────────────────

async function generateTheme(today: string): Promise<DailyTheme | null> {
  const logger = getLogger();
  const llmConfig = resolveLlmConfig();
  if (!llmConfig) {
    logger.warn('Daily theme: LLM not configured, using static fallback');
    const fallback = buildStaticFallback(today);
    themeCache = fallback;
    return fallback;
  }

  const date = new Date(today + 'T00:00:00+08:00');
  const staticInfo = getStaticDateInfo(date);

  const prompt = buildThemePrompt(date, staticInfo);

  try {
    const client = new LlmClient(llmConfig);
    const messages: LlmMessage[] = [
      { role: 'system', content: THEME_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ];

    const result = await client.complete(messages, {
      temperature: 0.8,
      maxTokens: 600,
      signal: AbortSignal.timeout(getGenerationTimeoutMs())
    });

    const parsed = parseThemeResponse(result.content, today);
    if (parsed) {
      themeCache = parsed;
      logger.info({ date: today, theme: parsed.theme, keywordCount: parsed.keywords.length }, 'Daily theme generated');
      return parsed;
    }

    logger.warn({ raw: result.content.slice(0, 200) }, 'Daily theme: failed to parse LLM response, using fallback');
  } catch (err) {
    logger.warn({ err }, 'Daily theme: LLM call failed, using fallback');
  }

  const fallback = buildStaticFallback(today);
  if (fallback) themeCache = fallback;
  return fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function getGenerationTimeoutMs(): number {
  const raw = Number(process.env.CROSSFADIO_DAILY_THEME_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GENERATION_TIMEOUT_MS;
}

// ── Prompt building ──────────────────────────────────────────────────────────

const THEME_SYSTEM_PROMPT = `你是一位电台节目策划人。根据日期信息和当天背景，为电台确定一个今日主题。

要求：
- 主题简洁有氛围感，10-20字，适合作为当日电台的主题语
- 输出3-6个音乐搜索关键词，中英文混合，覆盖主题相关的风格、情绪、场景
- 关键词用于在网易云音乐搜索歌曲，因此应是实际可搜的风格/情绪词或艺人名

输出格式：严格 JSON，只返回 JSON 对象，不要包裹 markdown 代码块。
{
  "theme": "今日主题语",
  "keywords": ["关键词1", "关键词2", ...]
}`;

function buildThemePrompt(date: Date, info: StaticDateInfo): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekday = weekdays[date.getDay()];

  let context = `今天是 ${date.getFullYear()}年${month}月${day}日，周${weekday}。`;

  if (info.holidays.length > 0) {
    context += `\n今日节日/纪念日：${info.holidays.join('、')}`;
  }
  if (info.solarTerm) {
    context += `\n今日节气：${info.solarTerm}`;
  }
  if (info.artistAnniversaries.length > 0) {
    context += `\n今日音乐人纪念日：${info.artistAnniversaries.join('、')}`;
  }
  if (info.seasonNote) {
    context += `\n季节提示：${info.seasonNote}`;
  }

  context += `\n\n请根据以上信息（以及你对今日重大新闻或社会氛围的了解），为电台确定一个今日主题和音乐搜索关键词。`;

  return context;
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseThemeResponse(raw: string, today: string): DailyTheme | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    const theme = typeof obj.theme === 'string' ? obj.theme.trim() : '';
    const keywords: string[] = [];

    if (Array.isArray(obj.keywords)) {
      for (const k of obj.keywords) {
        if (typeof k === 'string' && k.trim()) {
          keywords.push(k.trim());
        }
      }
    }

    if (!theme || keywords.length === 0) return null;

    return {
      date: today,
      theme: theme.slice(0, 100),
      keywords: keywords.slice(0, 8),
      generatedAt: Date.now()
    };
  } catch {
    return null;
  }
}

// ── Static fallback ──────────────────────────────────────────────────────────

function buildStaticFallback(today: string): DailyTheme | null {
  const date = new Date(today + 'T00:00:00+08:00');
  const info = getStaticDateInfo(date);

  const theme = info.holidays[0]
    ?? info.solarTerm
    ?? info.artistAnniversaries[0]?.split(' ')[0]
    ?? info.seasonNote
    ?? '日常音乐时光';

  const keywordTheme = typeof theme === 'string' ? theme : String(theme);
  const keywords = [keywordTheme, getSeasonStyle(date)];

  return {
    date: today,
    theme: typeof theme === 'string' ? `${theme}特辑` : `${String(theme)}特辑`,
    keywords,
    generatedAt: Date.now()
  };
}

// ── Static data lookup ───────────────────────────────────────────────────────

type StaticDateInfo = {
  holidays: string[];
  solarTerm: string | null;
  artistAnniversaries: string[];
  seasonNote: string | null;
};

function getStaticDateInfo(date: Date): StaticDateInfo {
  const mmdd = formatMMDD(date);
  const month = date.getMonth(); // 0-indexed
  const day = date.getDate();

  return {
    holidays: HOLIDAYS[mmdd] ?? [],
    solarTerm: findSolarTerm(month, day),
    artistAnniversaries: ARTIST_DATES[mmdd] ?? [],
    seasonNote: getSeasonNote(month)
  };
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatMMDD(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

function getSeasonNote(month: number): string | null {
  if (month >= 2 && month <= 4) return '春天，万物复苏';
  if (month >= 5 && month <= 7) return '夏天，热烈奔放';
  if (month >= 8 && month <= 10) return '秋天，沉静内敛';
  return '冬天，温暖治愈';
}

function getSeasonStyle(date: Date): string {
  const m = date.getMonth();
  if (m >= 2 && m <= 4) return 'indie folk';
  if (m >= 5 && m <= 7) return 'summer pop';
  if (m >= 8 && m <= 10) return 'jazz autumn';
  return 'warm acoustic';
}

// ── Solar terms (approximate, ±1 day) ────────────────────────────────────────

interface SolarTermRange { name: string; startMonth: number; startDay: number; endMonth: number; endDay: number }

const SOLAR_TERMS: SolarTermRange[] = [
  { name: '小寒', startMonth: 0, startDay: 5, endMonth: 0, endDay: 7 },
  { name: '大寒', startMonth: 0, startDay: 20, endMonth: 0, endDay: 22 },
  { name: '立春', startMonth: 1, startDay: 3, endMonth: 1, endDay: 5 },
  { name: '雨水', startMonth: 1, startDay: 18, endMonth: 1, endDay: 20 },
  { name: '惊蛰', startMonth: 2, startDay: 5, endMonth: 2, endDay: 7 },
  { name: '春分', startMonth: 2, startDay: 20, endMonth: 2, endDay: 22 },
  { name: '清明', startMonth: 3, startDay: 4, endMonth: 3, endDay: 6 },
  { name: '谷雨', startMonth: 3, startDay: 19, endMonth: 3, endDay: 21 },
  { name: '立夏', startMonth: 4, startDay: 5, endMonth: 4, endDay: 7 },
  { name: '小满', startMonth: 4, startDay: 20, endMonth: 4, endDay: 22 },
  { name: '芒种', startMonth: 5, startDay: 5, endMonth: 5, endDay: 7 },
  { name: '夏至', startMonth: 5, startDay: 21, endMonth: 5, endDay: 23 },
  { name: '小暑', startMonth: 6, startDay: 6, endMonth: 6, endDay: 8 },
  { name: '大暑', startMonth: 6, startDay: 22, endMonth: 6, endDay: 24 },
  { name: '立秋', startMonth: 7, startDay: 7, endMonth: 7, endDay: 9 },
  { name: '处暑', startMonth: 7, startDay: 22, endMonth: 7, endDay: 24 },
  { name: '白露', startMonth: 8, startDay: 7, endMonth: 8, endDay: 9 },
  { name: '秋分', startMonth: 8, startDay: 22, endMonth: 8, endDay: 24 },
  { name: '寒露', startMonth: 9, startDay: 8, endMonth: 9, endDay: 10 },
  { name: '霜降', startMonth: 9, startDay: 23, endMonth: 9, endDay: 25 },
  { name: '立冬', startMonth: 10, startDay: 7, endMonth: 10, endDay: 9 },
  { name: '小雪', startMonth: 10, startDay: 22, endMonth: 10, endDay: 24 },
  { name: '大雪', startMonth: 11, startDay: 6, endMonth: 11, endDay: 8 },
  { name: '冬至', startMonth: 11, startDay: 21, endMonth: 11, endDay: 23 },
];

function findSolarTerm(month: number, day: number): string | null {
  for (const term of SOLAR_TERMS) {
    if (month === term.startMonth && day >= term.startDay && day <= term.endDay) return term.name;
    if (month === term.endMonth && day >= term.startDay && day <= term.endDay) return term.name;
  }
  return null;
}

// ── Chinese + international holidays (MM-DD → names) ─────────────────────────

const HOLIDAYS: Record<string, string[]> = {
  '01-01': ['元旦'],
  '01-07': ['程序员节'],
  '02-14': ['情人节'],
  '03-08': ['国际妇女节'],
  '03-12': ['植树节'],
  '03-15': ['消费者权益日'],
  '03-21': ['世界睡眠日', '世界诗歌日'],
  '04-01': ['愚人节'],
  '04-22': ['世界地球日'],
  '04-23': ['世界读书日'],
  '05-01': ['国际劳动节'],
  '05-04': ['青年节'],
  '05-12': ['国际护士节'],
  '05-20': ['网络情人节'],
  '06-01': ['国际儿童节'],
  '06-05': ['世界环境日'],
  '06-21': ['世界音乐日'],
  '07-01': ['香港回归纪念日'],
  '07-07': ['七夕节（公历参考）'],
  '08-01': ['建军节'],
  '09-10': ['教师节'],
  '10-01': ['国庆节'],
  '10-31': ['万圣节'],
  '11-11': ['光棍节 / 双十一'],
  '12-24': ['平安夜'],
  '12-25': ['圣诞节'],
  '12-31': ['跨年夜'],
};

// ── Notable artist anniversaries (MM-DD) ─────────────────────────────────────

const ARTIST_DATES: Record<string, string[]> = {
  '01-08': ['David Bowie 诞辰（1947）'],
  '01-09': ['Joan Baez 诞辰（1941）'],
  '01-17': ['Eartha Kitt 诞辰（1927）'],
  '01-27': ['莫扎特诞辰（1756）'],
  '02-01': ['Lisa Marie Presley 诞辰（1968）'],
  '02-06': ['Bob Marley 诞辰（1945）'],
  '02-09': ['Carole King 诞辰（1942）'],
  '02-12': ['Ray Manzarek 诞辰（1939）'],
  '02-24': ['George Harrison 诞辰（1943）'],
  '02-25': ['George Harrison 诞辰'],
  '03-01': ['Justin Bieber 诞辰（1994）', 'Glenn Miller 诞辰（1904）'],
  '03-02': ['Lou Reed 诞辰（1942）', 'Jon Bon Jovi 诞辰（1962）'],
  '03-06': ['David Gilmour 诞辰（1946）'],
  '03-08': ['林忆莲诞辰'],
  '03-21': ['J.S. Bach 诞辰（1685）'],
  '03-25': ['Aretha Franklin 诞辰（1942）', 'Elton John 诞辰（1947）'],
  '03-30': ['Eric Clapton 诞辰（1945）'],
  '04-02': ['Marvin Gaye 诞辰（1939）'],
  '04-07': ['Billie Holiday 诞辰（1915）'],
  '04-08': ['Julian Lennon 诞辰（1963）'],
  '04-10': ['Paul McCartney（1970年披头士解散宣布日）'],
  '04-15': ['Bessie Smith 诞辰（1894）'],
  '04-21': ['Iggy Pop 诞辰（1947）'],
  '04-24': ['Barbra Streisand 诞辰（1942）'],
  '04-29': ['Duke Ellington 诞辰（1899）'],
  '05-01': ['Judy Collins 诞辰（1939）'],
  '05-03': ['James Brown 诞辰（1933）'],
  '05-05': ['Adele 诞辰（1988）'],
  '05-07': ['Tchaikovsky 诞辰（1840）'],
  '05-08': ['Robert Johnson 诞辰（1911）', '王菲诞辰（1969）'],
  '05-09': ['Billy Joel 诞辰（1949）'],
  '05-11': ['Bob Marley 逝世纪念日（1981）'],
  '05-13': ['Stevie Wonder 诞辰（1950）'],
  '05-14': ['David Byrne 诞辰（1952）'],
  '05-16': ['Janet Jackson 诞辰（1966）'],
  '05-18': ['Rick Wakeman 诞辰（1949）'],
  '05-19': ['Pete Townshend 诞辰（1945）'],
  '05-24': ['Bob Dylan 诞辰（1941）'],
  '05-26': ['Miles Davis 诞辰（1926）'],
  '05-28': ['Kylie Minogue 诞辰（1968）'],
  '05-29': ['Melanie B (Spice Girls) 诞辰（1975）'],
  '06-01': ['Alanis Morissette 诞辰（1974）'],
  '06-07': ['Prince 诞辰（1958）'],
  '06-09': ['Les Paul 诞辰（1915）'],
  '06-10': ['Judy Garland 诞辰（1922）'],
  '06-12': ['Chick Corea 诞辰（1941）'],
  '06-14': ['Boy George 诞辰（1961）'],
  '06-17': ['Igor Stravinsky 诞辰（1882）'],
  '06-18': ['Paul McCartney 诞辰（1942）'],
  '06-20': ['Brian Wilson 诞辰（1942）'],
  '06-22': ['Cyndi Lauper 诞辰（1953）'],
  '06-25': ['George Michael 诞辰（1963）'],
  '07-01': ['Debbie Harry 诞辰（1945）'],
  '07-04': ['Bill Withers 诞辰（1938）'],
  '07-07': ['Ringo Starr 诞辰（1940）'],
  '07-09': ['Courtney Love 诞辰（1964）'],
  '07-10': ['Arlo Guthrie 诞辰（1947）'],
  '07-13': ['罗大佑诞辰（1954）'],
  '07-19': ['Brian May 诞辰（1947）'],
  '07-22': ['Don Henley 诞辰（1947）'],
  '07-26': ['Mick Jagger 诞辰（1943）'],
  '08-04': ['Louis Armstrong 诞辰（1901）'],
  '08-09': ['Whitney Houston 诞辰（1963）'],
  '08-16': ['Madonna 诞辰（1958）'],
  '08-17': ['李宗盛诞辰'],
  '08-22': ['Tori Amos 诞辰（1963）'],
  '08-29': ['Michael Jackson 诞辰（1958）'],
  '09-01': ['Barry Gibb 诞辰（1946）'],
  '09-02': ['Salif Keita 诞辰（1949）'],
  '09-05': ['Freddie Mercury 诞辰（1946）'],
  '09-07': ['Buddy Holly 诞辰（1936）'],
  '09-12': ['Barry White 诞辰（1944）'],
  '09-16': ['B.B. King 诞辰（1925）'],
  '09-18': ['Jimi Hendrix 逝世纪念日（1970）'],
  '09-21': ['Leonard Cohen 诞辰（1934）'],
  '09-23': ['Bruce Springsteen 诞辰（1949）', 'Ray Charles 诞辰（1930）'],
  '09-26': ['Olivia Newton-John 诞辰（1948）'],
  '10-02': ['Sting 诞辰（1951）'],
  '10-03': ['Stevie Ray Vaughan 诞辰（1954）'],
  '10-04': ['Susan Sarandon (音乐相关)'],
  '10-09': ['John Lennon 诞辰（1940）'],
  '10-10': ['David Lee Roth 诞辰（1954）'],
  '10-14': ['Usher 诞辰（1978）'],
  '10-16': ['John Mayer 诞辰（1977）'],
  '10-18': ['Chuck Berry 诞辰（1926）'],
  '10-20': ['Tom Petty 诞辰（1950）'],
  '10-25': ['Katy Perry 诞辰（1984）'],
  '10-28': ['Frank Ocean 诞辰（1987）'],
  '11-10': ['Ennio Morricone 诞辰（1928）'],
  '11-14': ['Aaron Copland 诞辰（1900）'],
  '11-17': ['Jeff Buckley 诞辰（1966）'],
  '11-23': ['Miley Cyrus 诞辰（1992）'],
  '11-27': ['Jimi Hendrix 诞辰（1942）'],
  '11-29': ['Billy Strayhorn 诞辰（1915）'],
  '12-02': ['Britney Spears 诞辰（1981）'],
  '12-03': ['Ozzy Osbourne 诞辰（1948）'],
  '12-05': ['Little Richard 诞辰（1932）'],
  '12-08': ['Jim Morrison 诞辰（1943）', 'Sinéad O\'Connor 诞辰（1966）'],
  '12-09': ['周杰伦诞辰（1979）'],
  '12-12': ['Frank Sinatra 诞辰（1915）'],
  '12-13': ['Taylor Swift 诞辰（1989）'],
  '12-16': ['Ludwig van Beethoven 诞辰（1770）'],
  '12-21': ['Frank Zappa 诞辰（1940）'],
  '12-22': ['Robin & Maurice Gibb 诞辰（1949）'],
  '12-28': ['John Legend 诞辰（1978）'],
  '12-30': ['Patti Smith 诞辰（1946）'],
  '12-31': ['Donna Summer 诞辰（1948）'],
};
