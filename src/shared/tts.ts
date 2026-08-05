export const DEFAULT_TTS_MODEL = 'qwen3-tts-flash';
export const DEFAULT_TTS_VOICE = 'Cherry';
export const TTS_PREVIEW_TEXT = '你好，我是 Crossfadio 的 DJ。让音乐继续流动。';

export const QWEN3_TTS_VOICES = [
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Momo',
  'Vivian',
  'Moon',
  'Maia',
  'Kai',
  'Nofish',
  'Bella',
  'Jennifer',
  'Ryan',
  'Katerina',
  'Aiden',
  'Eldric Sage',
  'Mia',
  'Mochi',
  'Bellona',
  'Vincent',
  'Bunny',
  'Neil',
  'Elias',
  'Arthur',
  'Nini',
  'Seren',
  'Pip',
  'Stella',
  'Bodega',
  'Sonrisa',
  'Alek',
  'Dolce',
  'Sohee',
  'Ono Anna',
  'Lenn',
  'Emilien',
  'Andre',
  'Radio Gol',
  'Jada',
  'Dylan',
  'Li',
  'Marcus',
  'Roy',
  'Peter',
  'Sunny',
  'Eric',
  'Rocky',
  'Kiki'
] as const;

// 腾讯云语音合成（1073）基础音色（ModelType=1，按次计费）。
// 实测有效 VoiceType：1001-1005、1007-1010（1006 及 1011+ 不存在）。
// 名称与性别依据腾讯云官方音色表（智瑜/智聆/智云/智华等，经 SDK 文档与实测 F0 双重核对）。
// per-user `tts.voice` pref 存 id（字符串），如 '1001'。
export const TENCENT_TTS_VOICES = [
  { id: '1001', label: '智瑜 · 情感女声' },
  { id: '1002', label: '智聆 · 通用女声' },
  { id: '1003', label: '智美 · 客服女声' },
  { id: '1004', label: '智云 · 通用男声' },
  { id: '1005', label: '智莉 · 通用女声' },
  { id: '1007', label: '智娜 · 客服女声' },
  { id: '1008', label: '智琪 · 客服女声' },
  { id: '1009', label: '智芸 · 知性女声' },
  { id: '1010', label: '智华 · 通用男声' }
] as const;

export const TENCENT_TTS_VOICE_IDS = TENCENT_TTS_VOICES.map((v) => v.id);
