export type StyleGraphEntry = {
  style: string;
  aliases: string[];
  adjacent: string[];
};

export type SceneProfile = {
  scene: string;
  aliases: string[];
  rules: string[];
  queryTemplates: string[];
};

export type QueryTemplateGroup = {
  intent: string;
  aliases: string[];
  templates: string[];
};

export type NegativeMapping = {
  aliases: string[];
  mappings: string[];
};

export type MusicKnowledgeBase = {
  styleGraph: StyleGraphEntry[];
  sceneProfiles: SceneProfile[];
  queryTemplates: QueryTemplateGroup[];
  negativeMappings: NegativeMapping[];
  diversityRules: string[];
};

export const musicKnowledgeZhCN: MusicKnowledgeBase = {
  styleGraph: [
    {
      style: 'city pop',
      aliases: ['city pop', 'citypop', '城市流行'],
      adjacent: ['synth pop', 'j-pop', 'funk pop', 'disco pop', '粤语', '女声 city pop']
    },
    {
      style: 'indie pop',
      aliases: ['indie pop', '独立流行', '独立音乐'],
      adjacent: ['bedroom pop', 'dream pop', 'folk pop', 'lo-fi pop', '女声 indie pop']
    },
    {
      style: 'dream pop',
      aliases: ['dream pop', '梦幻流行', '氛围流行'],
      adjacent: ['shoegaze', 'ambient pop', 'indie pop', 'ethereal wave', '女声 dream pop']
    },
    {
      style: '粤语',
      aliases: ['粤语', '港乐', '广东歌'],
      adjacent: ['city pop', 'cantopop', '粤语女声', '港风流行', 'synth pop']
    },
    {
      style: '女声',
      aliases: ['女声', '女歌手', '女生唱', 'female vocal', 'female-vocal'],
      adjacent: ['华语女声', '粤语女声', 'city pop 女声', 'indie pop 女声', 'dream pop 女声']
    }
  ],
  sceneProfiles: [
    {
      scene: '上午',
      aliases: ['上午', '早上', '早晨', 'morning'],
      rules: ['上午优先清爽、明亮、中低能量，避免过早进入强节拍。'],
      queryTemplates: ['清爽 女声', 'indie pop 明亮', '轻快 华语']
    },
    {
      scene: '下午',
      aliases: ['下午', '午后', 'afternoon'],
      rules: ['下午适合中低能量、旋律清楚、不过度抢注意力的歌。'],
      queryTemplates: ['女声 轻松', 'city pop 柔和', 'indie pop 不吵']
    },
    {
      scene: '中午',
      aliases: ['中午', '午间', 'noon'],
      rules: ['中午适合轻快但不尖锐的曲目，保持节奏感同时避免过强压迫。'],
      queryTemplates: ['轻快 pop', '华语女声 明亮', 'city pop 轻松']
    },
    {
      scene: '傍晚',
      aliases: ['傍晚', '黄昏', '下班路上', 'evening commute'],
      rules: ['傍晚适合温暖、松弛、中等能量的歌，帮助从工作状态过渡。'],
      queryTemplates: ['温暖 女声', 'indie pop 松弛', '粤语 不吵']
    },
    {
      scene: '晚上',
      aliases: ['晚上', '夜晚', '晚间', 'evening', 'night'],
      rules: ['晚上优先松弛、耐听、中低能量，避免过亮或过密的编曲。'],
      queryTemplates: ['轻松 女声', 'dream pop 松弛', '粤语 不吵']
    },
    {
      scene: '深夜',
      aliases: ['深夜', '夜里', '凌晨', 'late night'],
      rules: ['深夜优先低动态、少打扰、留白感强的曲目。'],
      queryTemplates: ['dream pop 安静', '低动态 女声', '氛围流行 留白']
    },
    {
      scene: '跑步',
      aliases: ['跑步', '运动', '慢跑', 'running'],
      rules: ['跑步场景优先稳定律动和清晰鼓点，能量随配速上调。'],
      queryTemplates: ['稳定律动 pop', 'city pop 节奏', 'synth pop 高能量']
    }
  ],
  queryTemplates: [
    {
      intent: 'female-vocal',
      aliases: ['女声', '女歌手', '女生唱', 'female vocal', 'female-vocal'],
      templates: ['女声 轻松', '华语女声', '粤语女声', '女声 city pop', '女声 indie pop']
    },
    {
      intent: 'quiet',
      aliases: ['别太吵', '不要太吵', '安静', '轻一点', '不吵', 'quiet'],
      templates: ['安静 女声', '低能量 pop', '不吵 indie pop', '轻柔 dream pop']
    },
    {
      intent: 'afternoon',
      aliases: ['下午', '午后', 'afternoon'],
      templates: ['轻松 女声', 'city pop 柔和', '不吵 华语']
    },
    {
      intent: 'focus',
      aliases: ['专注', '工作', '学习', 'focus'],
      templates: ['专注 低人声', '工作 不吵 pop', '学习 dream pop', '少人声 氛围']
    }
  ],
  negativeMappings: [
    {
      aliases: ['别太吵', '不要太吵', '不吵', '轻一点', '安静'],
      mappings: ['排除高能量、强鼓点、喊唱、密集电音。', '降低 high energy / edm / hard rock 权重。']
    },
    {
      aliases: ['少人声', '少点人声', '低人声'],
      mappings: ['降低人声密度高、歌词信息量大的曲目。', '优先 instrumental、ambient pop、低人声版本。']
    },
    {
      aliases: ['不要人声', '无人声', '纯音乐'],
      mappings: ['排除主唱突出的人声曲目。', '优先 instrumental、ost、ambient、lo-fi。']
    }
  ],
  diversityRules: [
    '同一轮最多保留同艺人一首，除非用户明确要求该艺人。',
    '混合近期偏好和探索候选，避免全部来自同一来源。',
    '相邻推荐尽量错开语种、年代或编曲质感。',
    '如果用户表达随便推荐，优先给稳妥中等能量，再补一首轻探索。'
  ]
};
