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
// 实测有效 VoiceType 为 1001–1010；1011–1014 不存在。
// per-user `tts.voice` pref 存 id（字符串），如 '1001'。
export const TENCENT_TTS_VOICES = [
  { id: '1001', label: '亲和女声' },
  { id: '1002', label: '亲和男声' },
  { id: '1003', label: '成熟男声' },
  { id: '1004', label: '成熟女声' },
  { id: '1005', label: '严肃男声' },
  { id: '1006', label: '严肃女声' },
  { id: '1007', label: '活泼男声' },
  { id: '1008', label: '活泼女声' },
  { id: '1009', label: '温柔男声' },
  { id: '1010', label: '温柔女声' }
] as const;
