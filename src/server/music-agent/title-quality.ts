const AUTONOMOUS_LOW_QUALITY_TITLE_PATTERN = /(?:dj\s*版|车载\s*dj|dj\s*(?:串烧|舞曲)|(?:抖音|网络|热歌)[^|｜]{0,12}dj|\bdj\s*(?:version|edit)\b)/iu;

export function hasAutonomousLowQualityTitle(title: string): boolean {
  return AUTONOMOUS_LOW_QUALITY_TITLE_PATTERN.test(title.normalize('NFKC'));
}
