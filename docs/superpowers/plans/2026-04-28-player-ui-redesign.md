# Player UI 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将播放页面重构为顶栏 + 左右两栏布局，删除调试信息，让主要元素集中在一屏。

**Architecture:** 保留所有现有组件文件，不新增文件。`PlaybackTimeline` 简化为进度条 + 一行 A→B 文字。`NowPlayingHero` 去掉技术字段，展示艺术家名。`PlayerView` 整体布局从三栏改为 header + 左6列/右6列，NCM 面板收进 header dropdown。

**Tech Stack:** React 18, TypeScript, Tailwind CSS 3, Vitest (source-scan tests), Lucide React

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/renderer/components/player/PlaybackTimeline.tsx` | Modify | 删除双 Deck 可视化，保留进度条 + A→B 一行 |
| `src/renderer/components/player/NowPlayingHero.tsx` | Modify | 删除 badge / NCM ID / 技术字段，展示艺术家 |
| `src/renderer/components/player/SyncedLyrics.tsx` | Modify | 高度从 h-40 改为 h-48，加上下渐隐遮罩 |
| `src/renderer/views/Player/PlayerView.tsx` | Modify | header + 两栏布局，NCM chip dropdown，状态区移到右栏 |
| `tests/unit/player-layout.spec.ts` | Modify | 新增断言覆盖新布局特征 |

---

## Task 1: 简化 PlaybackTimeline 为进度条 + A→B 行

**Files:**
- Modify: `src/renderer/components/player/PlaybackTimeline.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/player-layout.spec.ts` 的 `describe('player layout', ...)` 块末尾追加：

```typescript
it('PlaybackTimeline does not render DeckCard or dual-deck section', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/components/player/PlaybackTimeline.tsx'),
    'utf-8'
  );

  expect(source).not.toContain('DeckCard');
  expect(source).not.toContain('双 Deck 混音台');
  expect(source).toContain('A→B');
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: FAIL — `expected string not to include 'DeckCard'`

- [ ] **Step 3: 替换 PlaybackTimeline.tsx 全文**

```typescript
import { buildPlaybackTimeline } from '@renderer/audio/timeline';
import type { PlaybackTiming } from '@shared/schema';

type PlaybackTimelineProps = {
  durationSec: number;
  positionSec: number;
  timing: PlaybackTiming | null;
  currentTrackId: string | null;
  nextTrackId: string | null;
  currentTrackName?: string;
  nextTrackName?: string;
  onSeek?: (positionSec: number) => void;
};

export function PlaybackTimeline(props: PlaybackTimelineProps): JSX.Element {
  const progressPct =
    props.durationSec > 0 ? (props.positionSec / props.durationSec) * 100 : 0;

  const timeline = props.timing
    ? buildPlaybackTimeline(props.durationSec, {
        positionSec: props.positionSec,
        timing: props.timing,
        duckingHintSec: 8
      })
    : null;

  // A→B: seconds until the segue window opens
  const timeToSegueSec = timeline
    ? Math.max(0, timeline.windowStartSec - props.positionSec)
    : 0;

  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
      {/* Progress bar row */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {formatClock(props.positionSec)}
        </span>
        <input
          aria-label="播放进度"
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-amber-400"
          max={props.durationSec || 0}
          min={0}
          onChange={(event) => props.onSeek?.(Number(event.target.value))}
          step={0.1}
          style={{
            background: `linear-gradient(90deg, #f59e0b 0%, #f59e0b ${progressPct}%, #27272a ${progressPct}%, #27272a 100%)`
          }}
          type="range"
          value={props.positionSec}
        />
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {formatClock(props.durationSec)}
        </span>
      </div>

      {/* A→B transition line */}
      {props.nextTrackId ? (
        <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden text-xs text-zinc-500">
          <span className="max-w-[160px] truncate text-amber-400/70">
            {props.currentTrackName ?? props.currentTrackId ?? 'A'}
          </span>
          <span className="shrink-0">——×——</span>
          <span className="max-w-[160px] truncate text-violet-400/70">
            {props.nextTrackName ?? props.nextTrackId}
          </span>
          <span className="shrink-0">· {Math.round(timeToSegueSec)}s 后切换</span>
        </div>
      ) : null}
    </section>
  );
}

function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '00:00';
  const rounded = Math.floor(totalSec);
  const minutes = Math.floor(rounded / 60).toString().padStart(2, '0');
  const seconds = (rounded % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: PASS — all tests green

- [ ] **Step 5: 检查 TypeScript 类型**

```bash
pnpm check
```

Expected: 0 errors. 如果 `PlayerView.tsx` 报错（因为传了已删除的 props），先忽略，Task 3 会修复。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/player/PlaybackTimeline.tsx tests/unit/player-layout.spec.ts
git commit -m "refactor(player): simplify PlaybackTimeline to progress bar + A→B line"
```

---

## Task 2: 清理 NowPlayingHero + 歌词高度

**Files:**
- Modify: `src/renderer/components/player/NowPlayingHero.tsx`
- Modify: `src/renderer/components/player/SyncedLyrics.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/player-layout.spec.ts` 末尾追加：

```typescript
it('NowPlayingHero does not show DJ Deck A badge or NCM ID', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/components/player/NowPlayingHero.tsx'),
    'utf-8'
  );

  expect(source).not.toContain('DJ Deck A');
  expect(source).not.toContain('NCM ID');
  expect(source).not.toContain('trackId');
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: FAIL — `expected string not to include 'DJ Deck A'`

- [ ] **Step 3: 替换 NowPlayingHero.tsx 全文**

```typescript
import { Heart } from 'lucide-react';
import { SyncedLyrics } from './SyncedLyrics';
import coverPlaceholder from '@renderer/assets/image2/cover-placeholder.svg';

type NowPlayingHeroProps = {
  title: string;
  subtitle: string;
  lyric: string;
  positionSec: number;
  isLiked: boolean;
  onToggleLike: () => void;
};

export function NowPlayingHero(props: NowPlayingHeroProps): JSX.Element {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <img
            alt="当前曲目封面"
            className="h-24 w-24 shrink-0 rounded-xl border border-zinc-700/70 object-cover"
            src={coverPlaceholder}
          />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold leading-tight text-zinc-100">{props.title}</h2>
            <p className="mt-1 truncate text-sm text-zinc-400">{props.subtitle}</p>
          </div>
        </div>
        <button
          aria-label={props.isLiked ? '取消喜欢' : '喜欢'}
          className={`shrink-0 inline-flex items-center rounded-full border p-2 transition ${
            props.isLiked
              ? 'border-violet-400/70 bg-violet-500/20 text-violet-200'
              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
          }`}
          onClick={props.onToggleLike}
          type="button"
        >
          <Heart className={`h-4 w-4 ${props.isLiked ? 'fill-current' : ''}`} />
        </button>
      </div>
      <SyncedLyrics lyric={props.lyric} positionSec={props.positionSec} />
    </section>
  );
}
```

- [ ] **Step 4: 修改 SyncedLyrics.tsx — 高度 h-40 → h-48，加渐隐遮罩**

在 `src/renderer/components/player/SyncedLyrics.tsx` 中，将 `h-40` 改为 `h-48`，并在滚动容器上追加渐隐遮罩：

旧代码（第 27-28 行附近）：
```typescript
    <div
      className="mt-4 h-40 overflow-y-auto rounded-xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-950/80 to-cyan-950/40 p-4 [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: 'none' }}
    >
```

新代码：
```typescript
    <div
      className="mt-4 h-48 overflow-y-auto rounded-xl border border-zinc-800 bg-gradient-to-br from-indigo-950/60 via-zinc-950/80 to-cyan-950/40 p-4 [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_12%,black_88%,transparent_100%)]"
      style={{ scrollbarWidth: 'none', WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)' }}
    >
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: PASS — all tests green

- [ ] **Step 6: 检查 TypeScript 类型**

```bash
pnpm check
```

Expected: `PlayerView.tsx` 可能报 `trackId` prop 不存在，Task 3 会修复。其余文件应无错误。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/components/player/NowPlayingHero.tsx src/renderer/components/player/SyncedLyrics.tsx tests/unit/player-layout.spec.ts
git commit -m "refactor(player): remove debug fields from NowPlayingHero, expand lyrics height"
```

---

## Task 3: 重构 PlayerView 为 header + 两栏布局

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/player-layout.spec.ts` 末尾追加：

```typescript
it('PlayerView uses two-column layout and removes the left sidebar', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
    'utf-8'
  );

  expect(source).not.toContain('col-span-2');
  expect(source).not.toContain('col-span-7');
  expect(source).not.toContain('col-span-3');
  expect(source).toContain('col-span-12');
  expect(source).toContain('col-span-6');
});

it('PlayerView removes the prefetch status panel', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
    'utf-8'
  );

  expect(source).not.toContain('预取状态');
  expect(source).not.toContain('prefetchLeadSec');
});

it('PlayerView has NCM chip dropdown controlled by showNcmDropdown state', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/views/Player/PlayerView.tsx'),
    'utf-8'
  );

  expect(source).toContain('showNcmDropdown');
  expect(source).toContain('setShowNcmDropdown');
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: FAIL — 多条断言失败

- [ ] **Step 3: 在 PlayerView.tsx 顶部 state 区增加 showNcmDropdown**

在 `src/renderer/views/Player/PlayerView.tsx` 第 91 行附近，在 `const [qrPayload, ...]` 之后追加：

```typescript
  const [showNcmDropdown, setShowNcmDropdown] = useState(false);
```

- [ ] **Step 4: 删除 Radio import（不再使用）**

将导入行：
```typescript
import {
  CalendarDays,
  LogOut,
  QrCode,
  Radio,
  ScanSearch,
  Settings2
} from 'lucide-react';
```

改为：
```typescript
import {
  CalendarDays,
  LogOut,
  QrCode,
  ScanSearch,
  Settings2
} from 'lucide-react';
```

- [ ] **Step 5: 替换 PlayerView 的 JSX return（从 `<main>` 到结尾）**

将第 666 行开始的整个 `return (...)` 替换为：

```tsx
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#1f2b5e_0%,#080b14_35%,#070a12_100%)] p-6 text-zinc-100">
      <div className="mx-auto grid max-w-[1480px] grid-cols-12 gap-4">

        {/* Header */}
        <header className="col-span-12 flex items-center justify-between gap-4 rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <img alt="Crossfadio 应用图标" className="h-7 w-7 rounded-lg" src={appMark} />
            <span className="text-lg font-semibold tracking-tight text-violet-200">Crossfadio</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('plan')}
              type="button"
            >
              <CalendarDays className="h-4 w-4" />
              今日计划
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
              onClick={() => onNavigate?.('settings')}
              type="button"
            >
              <Settings2 className="h-4 w-4" />
              设置
            </button>
            <div className="relative">
              <button
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900"
                onClick={() => setShowNcmDropdown((v) => !v)}
                type="button"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${session.hasCookie ? 'bg-green-400' : 'bg-red-400'}`}
                />
                {session.hasCookie ? '已登录' : '未登录'}
              </button>
              {showNcmDropdown ? (
                <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-56 rounded-xl border border-zinc-700 bg-zinc-950/95 p-3 shadow-xl">
                  <div className="flex flex-col gap-1.5 text-xs text-zinc-300">
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        try {
                          const qr = await createNcmQr();
                          setQrPayload({ key: qr.key, qrimg: qr.qrimg });
                          setError('');
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '创建二维码失败');
                        }
                      }}
                      type="button"
                    >
                      <QrCode className="h-4 w-4 shrink-0" />
                      二维码登录
                    </button>
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        if (!qrPayload?.key) return;
                        try {
                          const status = await checkNcmQr(qrPayload.key);
                          setTrackStatusText(`扫码状态: ${status.hint}`);
                          await refreshSession();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '扫码状态查询失败');
                        }
                      }}
                      type="button"
                    >
                      <ScanSearch className="h-4 w-4 shrink-0" />
                      检查状态
                    </button>
                    <button
                      className="inline-flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 hover:border-zinc-500"
                      onClick={async () => {
                        try {
                          await logoutNcm();
                          await refreshSession();
                          setTrackStatusText('已登出 NCM');
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '登出失败');
                        }
                      }}
                      type="button"
                    >
                      <LogOut className="h-4 w-4 shrink-0" />
                      登出
                    </button>
                    {qrPayload ? (
                      <img
                        alt="ncm login qr"
                        className="mt-2 h-28 w-28 rounded border border-zinc-700 bg-white p-1"
                        src={qrPayload.qrimg}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* Left column — player */}
        <section className="col-span-6 space-y-4">
          <NowPlayingHero
            isLiked={isLiked}
            lyric={nowPlaying?.lyric ?? ''}
            onToggleLike={handleToggleLike}
            positionSec={positionSec}
            subtitle={currentTrack?.artists.join(' / ') ?? ''}
            title={currentTrack?.name ?? 'No Track'}
          />

          <PlaybackTimeline
            currentTrackId={currentTrackId}
            currentTrackName={currentTrack?.name}
            durationSec={durationSec}
            nextTrackId={nextTrack?.track.id ?? null}
            nextTrackName={nextTrack?.track.name}
            onSeek={handleSeek}
            positionSec={positionSec}
            timing={nowPlaying?.timing ?? null}
          />

          <TransportControls
            canPrev={canPrev}
            canSkip={canSkip}
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            onPrev={handlePrev}
            onSkip={handleSkip}
          />

          <audio
            onEnded={onEnded}
            onLoadedMetadata={onLoadedMetadata}
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onTimeUpdate={onTimeUpdate}
            ref={audioRef}
          />
        </section>

        {/* Right column — queue + status */}
        <section className="col-span-6 flex flex-col gap-4">
          <QueuePanel
            currentIndex={currentIndex}
            nextId={nextTrack?.track.id ?? null}
            onSelectIndex={handleSelectIndex}
            queue={queue}
          />

          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatusChip label="曲目" text={trackStatusText || '—'} />
              <StatusChip color="cyan" label="DJ选歌" text={djStatusText || '空闲'} />
              <StatusChip color="violet" label="过渡文案" text={segueStatusText || '空闲'} />
              {error ? <span className="text-xs text-red-300">{error}</span> : null}
            </div>
            <button
              className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
              onClick={() => void loadLikedQueue()}
              type="button"
            >
              重新开始 DJ 模式
            </button>
          </div>
        </section>

      </div>
    </main>
  );
```

- [ ] **Step 6: 在 PlayerView.tsx 中添加 StatusChip 辅助组件**

在 `export function PlayerView(...)` 之前（文件末尾之前）插入：

```typescript
function StatusChip({
  label,
  text,
  color = 'zinc'
}: {
  label: string;
  text: string;
  color?: 'zinc' | 'cyan' | 'violet';
}): JSX.Element {
  const textColor =
    color === 'cyan'
      ? 'text-cyan-300'
      : color === 'violet'
        ? 'text-violet-200'
        : 'text-zinc-200';
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-zinc-500">{label}：</span>
      <span className={textColor}>{text}</span>
    </span>
  );
}
```

- [ ] **Step 7: 运行全部测试**

```bash
pnpm test -- --reporter=verbose tests/unit/player-layout.spec.ts
```

Expected: PASS — all tests green

- [ ] **Step 8: 检查 TypeScript 类型**

```bash
pnpm check
```

Expected: 0 errors

- [ ] **Step 9: 提交**

```bash
git add src/renderer/views/Player/PlayerView.tsx tests/unit/player-layout.spec.ts
git commit -m "refactor(player): two-column layout, NCM chip dropdown, status area in right rail"
```

---

## Task 4: 全量验收

- [ ] **Step 1: 跑全部测试**

```bash
pnpm test
```

Expected: 所有测试通过，包括 `playback-timeline.spec.ts`（它测的是 `buildPlaybackTimeline` 函数，不受本次改动影响）

- [ ] **Step 2: 检查类型**

```bash
pnpm check
```

Expected: 0 errors

- [ ] **Step 3: 启动开发服务，目测检查**

```bash
pnpm dev
```

打开 `http://localhost:5173`，确认：
- 顶栏显示 Logo + 今日计划 + 设置 + NCM 状态 chip
- 点击 NCM chip 展开 dropdown，显示登录控件
- 左栏：封面 + 标题 + 艺术家 + 喜欢按钮，歌词区 h-48 带渐隐效果
- 左栏：进度条一行，A→B 文字一行（有下一首时显示）
- 左栏：播放控制三个按钮
- 右栏：播放队列置顶
- 右栏：状态 chip 行 + 重新开始DJ模式小按钮
- 没有左侧边栏、没有双 Deck 卡片、没有预取状态面板

- [ ] **Step 4: 提交（如有未提交的零散改动）**

```bash
git status
# 如有未提交内容：
git add -p
git commit -m "chore(player): post-redesign cleanup"
```
