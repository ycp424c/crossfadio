import type { LlmMessage } from '../llm/client.js';
import type { Fragments } from './schema.js';

/**
 * Assembles 6 Fragments slices into an LLM message array.
 *
 * Message layout (per §6.5 of architecture doc):
 *   1. system  → system message  (dj-persona + mode constraint)
 *   2. user    → <corpus> + <env>
 *   3. user    → <memory>
 *   4. user    → input + trace
 */
export function assembleMessages(fragments: Fragments): LlmMessage[] {
  return [
    { role: 'system', content: fragments.system },
    { role: 'user', content: buildCorpusEnvSlice(fragments) },
    { role: 'user', content: buildMemorySlice(fragments) },
    { role: 'user', content: buildInputSlice(fragments) }
  ];
}

function buildCorpusEnvSlice(f: Fragments): string {
  const playlists = f.corpus.playlists
    .map((p) => {
      const tags = p.tags.length ? ` [${p.tags.join(', ')}]` : '';
      const segments = p.segments.length ? ` 时段:${p.segments.join('/')}` : '';
      return `- ${p.name}${tags}${segments}`;
    })
    .join('\n');

  const likedTracks = (f.corpus.likedTracks ?? [])
    .slice(0, 50)
    .map((track) => `- ${track.name ?? track.id}${track.artist ? ` — ${track.artist}` : ''}`)
    .join('\n');

  const weather = f.env.weather
    ? `${f.env.weather.tempC}°C，${f.env.weather.desc}`
    : '未知';

  const nowPlaying = f.env.nowPlaying
    ? `${f.env.nowPlaying.name} — ${f.env.nowPlaying.artist}`
    : '无';

  return `<corpus>
<taste>
${f.corpus.taste}
</taste>
<routines>
${f.corpus.routines}
</routines>
<mood_rules>
${f.corpus.moodRules}
</mood_rules>
<playlists>
${playlists || '（无歌单）'}
</playlists>
<liked_tracks>
${likedTracks || '（暂无红心歌曲）'}
</liked_tracks>
</corpus>
<env>
当前时间：${f.env.localTime}（${f.env.nowIso}）
天气：${weather}
正在播放：${nowPlaying}
</env>`;
}

function buildMemorySlice(f: Fragments): string {
  const recentPlays = f.memory.recentPlays
    .slice(0, 50)
    .map((p) => `- ${p.song_name ?? '?'} — ${p.artist_name ?? '?'} (${p.started_at})`)
    .join('\n');

  const recentChat = f.memory.recentChat
    .slice(0, 20)
    .map((m) => `${m.role === 'user' ? '用户' : 'DJ'}：${m.content}`)
    .join('\n');

  return `<memory>
<recent_plays>
${recentPlays || '（暂无播放记录）'}
</recent_plays>
<recent_chat>
${recentChat || '（暂无聊天记录）'}
</recent_chat>
</memory>`;
}

function buildInputSlice(f: Fragments): string {
  let inputText: string;

  switch (f.input.kind) {
    case 'chat':
      inputText = f.input.text;
      break;
    case 'segueTrigger':
      inputText = `[串场触发] 从"${f.input.from.name ?? f.input.from.id}"切到"${f.input.to.name ?? f.input.to.id}"${renderSegueContext(
        f
      )}`;
      break;
    case 'planRequest':
      inputText = `[计划请求] 日期：${f.input.date}`;
      break;
    case 'toolResult':
      inputText = `[工具结果] ${f.input.tool}：${JSON.stringify(f.input.data)}`;
      break;
  }

  const traceText = `[trace] triggeredBy=${f.trace.triggeredBy}${
    f.trace.lastDecision ? `，lastDecision=${JSON.stringify(f.trace.lastDecision)}` : ''
  }`;

  return `${inputText}\n${traceText}`;
}

function renderSegueContext(f: Fragments): string {
  if (f.input.kind !== 'segueTrigger' || !f.input.context) {
    return '';
  }

  const from = f.input.context.from;
  const to = f.input.context.to;

  return `
<segue_context>
<from_track>
歌名：${from.name}
艺人：${from.artist}
标签：${from.tags.join(' / ') || '无'}
歌词片段：${from.lyricExcerpt || '无'}
歌词关键词：${from.lyricKeywords.join(' / ') || '无'}
</from_track>
<to_track>
歌名：${to.name}
艺人：${to.artist}
标签：${to.tags.join(' / ') || '无'}
歌词片段：${to.lyricExcerpt || '无'}
歌词关键词：${to.lyricKeywords.join(' / ') || '无'}
</to_track>
</segue_context>`;
}
