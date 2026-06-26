export type LegacyStyleArtistDiscovery = {
  styleConcepts: string[];
  llmArtists: string[];
};

export function parseLegacyStyleArtistResponse(raw: string): LegacyStyleArtistDiscovery {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { styleConcepts: [], llmArtists: [] };
  }

  const parsed: unknown = JSON.parse(match[0]);
  const styleConcepts: string[] = [];
  const llmArtists: string[] = [];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const styles = Array.isArray(obj.styles) ? obj.styles : [];
    const seen = new Set<string>();
    for (const s of styles) {
      if (!s || typeof s !== 'object') continue;
      const style = s as Record<string, unknown>;
      if (typeof style.style === 'string' && style.style.trim()) {
        styleConcepts.push(style.style.trim());
      }
      const artists = Array.isArray(style.artists) ? style.artists : [];
      for (const a of artists) {
        if (typeof a === 'string' && a.trim() && a.trim().length < 50) {
          const lower = a.trim().toLowerCase();
          if (!seen.has(lower)) {
            seen.add(lower);
            llmArtists.push(a.trim());
          }
        }
      }
    }
  }

  return { styleConcepts, llmArtists };
}
