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

// 腾讯云语音合成（产品 1073）音色表。类别由 VoiceType 前缀决定（官方音色列表：
// cloud.tencent.com/document/product/1073/92668），TextToVoice 请求 ModelType 固定为
// 1-默认模型（官方当前文档仅支持该值），精品/大模型/超自然音色直接换 VoiceType 即可。
// 各档自然度与价格（后付费，官方计费概述 cloud.tencent.com/document/product/1073/34112）：
//   基础音色（1001-1010）          最生硬，按次计费、性价比最高
//   精品音色（101xxx）             韵律流畅、音质清晰，约 0.3 元/万字符（与基础共用 800 万字符免费额度）
//   大模型音色（501xxx/601xxx）    语气韵律自然，约 1.2 元/万字符（10 万字符免费额度）
//   超自然大模型音色（502xxx/602xxx/603xxx） 拟人度表现力最佳，约 6.5 元/万字符（2 万字符免费额度）
// 多情感音色（601008/601009/601010）额外支持 EmotionCategory/EmotionIntensity 参数。
// 实测有效基础 VoiceType：1001-1005、1007-1010（1006 及 1011+ 不存在）。
// per-user `tts.voice.tencent-cloud` pref 存 id（字符串），如 '1001'；旧 `tts.voice` 仅作懒迁移回退。
export type TencentTtsVoiceCategory = '基础音色' | '精品音色' | '大模型音色' | '超自然大模型音色';

export const TENCENT_TTS_VOICE_CATEGORY_PRICING = {
  基础音色: '基础档（按次计费）',
  精品音色: '精品档（后付费 0.3 元/万字符）',
  大模型音色: '大模型档（后付费首档 1.2 元/万字符）',
  超自然大模型音色: '超自然档（后付费首档 6.5 元/万字符）'
} as const satisfies Record<TencentTtsVoiceCategory, string>;

export type TencentTtsVoice = {
  id: string;
  label: string;
  category: TencentTtsVoiceCategory;
};

export const TENCENT_TTS_VOICES = [
  // ── 基础音色（ModelType=1，按次计费） ──────────────────────────────
  { id: '1001', label: '智瑜 · 情感女声', category: '基础音色' },
  { id: '1002', label: '智聆 · 通用女声', category: '基础音色' },
  { id: '1003', label: '智美 · 客服女声', category: '基础音色' },
  { id: '1004', label: '智云 · 通用男声', category: '基础音色' },
  { id: '1005', label: '智莉 · 通用女声', category: '基础音色' },
  { id: '1007', label: '智娜 · 客服女声', category: '基础音色' },
  { id: '1008', label: '智琪 · 客服女声', category: '基础音色' },
  { id: '1009', label: '智芸 · 知性女声', category: '基础音色' },
  { id: '1010', label: '智华 · 通用男声', category: '基础音色' },
  // ── 精品音色（101xxx） ─────────────────────────────────────────────
  { id: '101001', label: '智瑜 · 情感女声（精品）', category: '精品音色' },
  { id: '101004', label: '智云 · 通用男声（精品）', category: '精品音色' },
  { id: '101013', label: '智辉 · 新闻男声（精品）', category: '精品音色' },
  { id: '101016', label: '智甜 · 女童声（精品）', category: '精品音色' },
  { id: '101019', label: '智彤 · 粤语女声（精品）', category: '精品音色' },
  { id: '101030', label: '智柯 · 通用男声（精品）', category: '精品音色' },
  { id: '101055', label: '智付 · 通用女声（精品）', category: '精品音色' },
  // ── 大模型音色（501xxx/601xxx） ────────────────────────────────────
  { id: '501000', label: '智斌 · 阅读男声（大模型）', category: '大模型音色' },
  { id: '501001', label: '智兰 · 资讯女声（大模型）', category: '大模型音色' },
  { id: '501004', label: '月华 · 聊天女声（大模型）', category: '大模型音色' },
  { id: '501005', label: '飞镜 · 聊天男声（大模型）', category: '大模型音色' },
  { id: '601008', label: '爱小豪 · 聊天男声（大模型 · 多情感）', category: '大模型音色' },
  { id: '601009', label: '爱小芊 · 聊天女声（大模型 · 多情感）', category: '大模型音色' },
  { id: '601010', label: '爱小娇 · 聊天女声（大模型 · 多情感）', category: '大模型音色' },
  { id: '601014', label: '爱小简 · 聊天男声（大模型）', category: '大模型音色' },
  // ── 超自然大模型音色（502xxx/602xxx/603xxx） ──────────────────────
  { id: '502001', label: '智小柔 · 聊天女声（超自然）', category: '超自然大模型音色' },
  { id: '502003', label: '智小敏 · 聊天女声（超自然）', category: '超自然大模型音色' },
  { id: '502005', label: '智小解 · 解说男声（超自然）', category: '超自然大模型音色' },
  { id: '502006', label: '智小悟 · 聊天男声（超自然）', category: '超自然大模型音色' },
  { id: '602003', label: '爱小悠 · 聊天女声（超自然）', category: '超自然大模型音色' },
  { id: '602004', label: '暖心阿灿 · 聊天男声（超自然）', category: '超自然大模型音色' },
  { id: '603005', label: '知心大林 · 聊天男声（超自然）', category: '超自然大模型音色' },
  { id: '603007', label: '邻家女孩 · 聊天女声（超自然）', category: '超自然大模型音色' }
] as const satisfies readonly TencentTtsVoice[];

export const TENCENT_TTS_VOICE_IDS = TENCENT_TTS_VOICES.map((v) => v.id);
