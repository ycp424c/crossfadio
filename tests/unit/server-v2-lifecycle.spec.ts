import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DJ v2 server lifecycle', () => {
  it('starts unified retention, extraction, and narration after DB init and stops them first', () => {
    const source = fs.readFileSync('src/server/index.ts', 'utf8');

    expect(source).toContain("from './maintenance/retention.js'");
    expect(source).toContain("from './jobs/selection-narration-runtime.js'");
    expect(source).toContain("from './jobs/preference-extraction-runtime.js'");
    expect(source).toContain("from './jobs/explicit-exclusion-resolution-runtime.js'");
    expect(source).not.toContain('cleanupStaleListeningEpisodes');

    const init = source.indexOf('initDb();');
    const startRetention = source.indexOf('startRetentionMaintenance(');
    const startNarration = source.indexOf('selectionNarrationRuntime.start()');
    const startExtraction = source.indexOf('preferenceExtractionRuntime.start()');
    const startExclusionResolution = source.indexOf('explicitExclusionResolutionRuntime.start()');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(startRetention).toBeGreaterThan(init);
    expect(startNarration).toBeGreaterThan(startRetention);
    expect(startExtraction).toBeGreaterThan(startRetention);
    expect(startExclusionResolution).toBeGreaterThan(startRetention);

    const shutdown = source.indexOf('async function shutdown');
    const stopNarration = source.indexOf('await selectionNarrationRuntime.stop()', shutdown);
    const stopExtraction = source.indexOf('await preferenceExtractionRuntime.stop()', shutdown);
    const stopExclusionResolution = source.indexOf(
      'await explicitExclusionResolutionRuntime.stop()', shutdown
    );
    const stopRetention = source.indexOf('retentionMaintenance?.stop()', shutdown);
    const stopNcm = source.indexOf('await ncm.stop()', shutdown);
    expect(stopNarration).toBeGreaterThan(shutdown);
    expect(stopExtraction).toBeGreaterThan(shutdown);
    expect(stopExclusionResolution).toBeGreaterThan(shutdown);
    expect(stopRetention).toBeGreaterThan(shutdown);
    expect(stopNarration).toBeLessThan(stopNcm);
    expect(stopExtraction).toBeLessThan(stopNcm);
    expect(stopExclusionResolution).toBeLessThan(stopNcm);
    expect(stopRetention).toBeLessThan(stopNcm);
  });
});
