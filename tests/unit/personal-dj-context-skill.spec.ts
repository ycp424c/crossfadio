import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const buildScript = path.join(
  root,
  'skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py'
);

describe('crossfadio Personal DJ Context skill scripts', () => {
  it('builds strict payload from a LifeMesh bundle fixture without raw slice content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-personal-dj-context-skill-'));
    const bundlePath = path.join(tmpDir, 'bundle.json');
    const outPath = path.join(tmpDir, 'payload.json');

    fs.writeFileSync(bundlePath, JSON.stringify({
      schema_version: '1',
      bundle_id: 'bundle-fixture-1',
      task: {
        description: '为今天的 coding session 生成 AI DJ 上下文'
      },
      slices: [
        {
          slice_id: 'slice-1',
          evidence_role: 'context',
          citation: { label: 'manual-input-v1:focus' },
          heading: 'Focus',
          content: 'SECRET_RAW_CONTENT_SHOULD_NOT_LEAK 代码 专注 debug'
        },
        {
          slice_id: 'slice-2',
          evidence_role: 'raw',
          citation: { label: 'obsidian:daily-note' },
          content: 'another raw private sentence'
        }
      ]
    }));

    execFileSync('python3', [
      buildScript,
      '--bundle-file',
      bundlePath,
      '--out',
      outPath
    ], {
      cwd: root,
      encoding: 'utf-8'
    });

    const payload = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as Record<string, unknown>;
    const serialized = JSON.stringify(payload);

    expect(payload.schemaVersion).toBe(1);
    expect(payload.source).toMatchObject({
      kind: 'lifemesh_bundle',
      bundleId: 'bundle-fixture-1',
      sliceRefs: [
        {
          sliceId: 'slice-1',
          evidenceRole: 'context',
          citationLabel: 'manual-input-v1:focus'
        },
        {
          sliceId: 'slice-2',
          evidenceRole: 'raw',
          citationLabel: 'obsidian:daily-note'
        }
      ]
    });
    expect(serialized).not.toContain('SECRET_RAW_CONTENT_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('another raw private sentence');
    expect(serialized).not.toContain('"slices"');
    expect(serialized).not.toContain('"content"');
    expect(payload).toHaveProperty('summary');
    expect(payload).toHaveProperty('segueGuidance');
  });
});
