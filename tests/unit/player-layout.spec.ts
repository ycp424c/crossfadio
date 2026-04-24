import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('player layout', () => {
  it('allows the active view to scroll instead of clipping tall player content', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');

    expect(source).toContain('flex-1 overflow-y-auto');
    expect(source).not.toContain('flex-1 overflow-hidden');
  });

  it('limits queue list height and scrolls the playlist internally', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/components/player/QueuePanel.tsx'), 'utf-8');

    expect(source).toContain('max-h-');
    expect(source).toContain('overflow-y-auto');
  });
});
