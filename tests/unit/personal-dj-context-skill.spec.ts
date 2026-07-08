import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const execFileAsync = promisify(execFile);
const buildScript = path.join(
  root,
  'skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py'
);
const uploadScript = path.join(
  root,
  'skills/crossfadio-personal-dj-context/scripts/upload_personal_dj_context.py'
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

  it('fails with a non-zero status when upload is rejected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-personal-dj-context-upload-'));
    const payloadPath = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1 }));
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'boom' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address() as AddressInfo;
      const result = await runScript('python3', [
        uploadScript,
        '--file',
        payloadPath,
        '--base-url',
        `http://127.0.0.1:${address.port}`,
        '--token',
        'cfdj_ctx_test',
        '--timeout',
        '2'
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('upload failed: status=500');
      expect(result.stdout).not.toContain('uploaded Personal DJ Context');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

async function runScript(command: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      encoding: 'utf-8'
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (err) {
    const failed = err as { code?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof failed.code === 'number' ? failed.code : null,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? ''
    };
  }
}
