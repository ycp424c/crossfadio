export type SourceStyleSeedGroup = {
  aliases: string[];
  styles: string[];
};

// Source: MusicBrainz official genre list, fetched from
// https://musicbrainz.org/ws/2/genre/all?fmt=txt on 2026-06-12.
// These are style seeds for LLM/query expansion, not direct search templates.
export const musicBrainzDefaultStyleSeeds = [
  'indie pop',
  'dream pop',
  'city pop',
  'neo soul',
  'nu jazz',
  'downtempo',
  'synth-pop',
  'cantopop',
  'mandopop',
  'bossa nova',
  'chillout',
  'ambient pop'
];

export const musicBrainzStyleSeedGroups: SourceStyleSeedGroup[] = [
  {
    aliases: ['city pop', 'citypop', '城市流行', '城市流行音乐'],
    styles: [
      'city pop',
      'neo-city pop',
      'shibuya-kei',
      'j-pop',
      'cantopop',
      'mandopop',
      'c-pop',
      'synth-pop',
      'future funk',
      'vaporwave',
      'disco',
      'boogie'
    ]
  },
  {
    aliases: ['女声', '女歌手', '女生唱', 'female vocal', 'female-vocal', '轻松', '不吵', '安静'],
    styles: [
      'indie pop',
      'dream pop',
      'bedroom pop',
      'baroque pop',
      'art pop',
      'chamber pop',
      'ambient pop',
      'folk pop',
      'sophisti-pop',
      'neo soul',
      'alternative r&b',
      'contemporary r&b'
    ]
  },
  {
    aliases: ['jazz', '爵士', 'fusion', '拉丁爵士', 'bossa', 'funk', '放克', 'soul', '灵魂'],
    styles: [
      'jazz',
      'nu jazz',
      'acid jazz',
      'latin jazz',
      'cool jazz',
      'jazz rap',
      'bossa nova',
      'samba',
      'funk',
      'soul',
      'blue-eyed soul',
      'chipmunk soul'
    ]
  },
  {
    aliases: ['电子', 'electronic', 'synth', '合成器', 'dance', '跳舞', '律动'],
    styles: [
      'electropop',
      'synth-pop',
      'new wave',
      'chillwave',
      'dreamwave',
      'downtempo',
      'trip hop',
      'deep house',
      'garage house',
      'uk garage',
      'drum and bass',
      'future bass'
    ]
  },
  {
    aliases: ['rock', '摇滚', 'indie rock', '独立摇滚', '乐队', 'guitar'],
    styles: [
      'indie rock',
      'alternative rock',
      'soft rock',
      'classic rock',
      'art rock',
      'pop rock',
      'psychedelic pop',
      'psychedelic rock',
      'shoegaze',
      'post-rock',
      'new wave',
      'britpop'
    ]
  },
  {
    aliases: ['hip hop', 'hip-hop', 'rap', '说唱', 'r&b'],
    styles: [
      'alternative hip hop',
      'abstract hip hop',
      'conscious hip hop',
      'jazz rap',
      'lo-fi hip hop',
      'pop rap',
      'east coast hip hop',
      'west coast hip hop',
      'alternative r&b',
      'neo soul',
      'contemporary r&b',
      'trap'
    ]
  },
  {
    aliases: ['专注', '工作', '学习', 'focus', 'ambient', '氛围', '低人声', '少人声'],
    styles: [
      'ambient',
      'ambient pop',
      'ambient house',
      'ambient techno',
      'new age',
      'minimalism',
      'downtempo',
      'chillout',
      'lounge',
      'electroacoustic',
      'classical crossover',
      'contemporary jazz'
    ]
  },
  {
    aliases: ['粤语', '港乐', '广东歌', '华语', '中文', 'mandarin', 'cantonese'],
    styles: [
      'cantopop',
      'mandopop',
      'c-pop',
      'zhongguo feng',
      'cantonese opera',
      'city pop',
      'sophisti-pop',
      'pop rock',
      'indie pop',
      'jazz rap',
      'neo soul',
      'alternative r&b'
    ]
  },
  {
    aliases: ['清爽', 'bright'],
    styles: [
      'indie pop',
      'folk pop',
      'chamber pop',
      'bossa nova',
      'cool jazz',
      'neo soul',
      'j-pop',
      'mandopop',
      'sophisti-pop',
      'acoustic rock',
      'contemporary folk',
      'americana'
    ]
  },
  {
    aliases: ['跑步', '运动', 'running', 'workout', '高能量', '提神'],
    styles: [
      'dance-pop',
      'electropop',
      'dance-rock',
      'breakbeat',
      'drum and bass',
      'house',
      'afrobeats',
      'afrobeat',
      'eurodance',
      'future bass',
      'pop rap',
      'alternative dance'
    ]
  }
];
