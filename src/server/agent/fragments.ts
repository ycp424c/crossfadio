import type { LlmMessage } from '../llm/client.js';
import type { Fragments } from './schema.js';

/**
 * Assembles purpose-scoped DJ Memory and the current input into messages.
 *
 * Message layout (per §6.5 of architecture doc):
 *   1. system  → system message  (dj-persona + mode constraint)
 *   2. user    → one shared DJ Memory purpose projection
 *   3. user    → input + trace
 */
export function assembleMessages(fragments: Fragments): LlmMessage[] {
  return [
    { role: 'system', content: fragments.system },
    { role: 'user', content: buildDjMemorySlice(fragments) },
    { role: 'user', content: buildInputSlice(fragments) }
  ];
}

function buildDjMemorySlice(f: Fragments): string {
  return `<dj_memory purpose="${f.djMemory.purpose}">
${JSON.stringify(f.djMemory)}
</dj_memory>`;
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

  const djPickReason = f.input.context.djPickReason;
  const selectionRationale = f.input.context.selectionRationale;

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
</to_track>${djPickReason ? `\n<dj_pick_reason>${djPickReason}</dj_pick_reason>` : ''}${selectionRationale ? `\n<selection_rationale>${selectionRationale}</selection_rationale>` : ''}
</segue_context>`;
}
