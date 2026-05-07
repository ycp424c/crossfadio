# Mobile UI Adaptation Design

**Date**: 2026-05-07
**Status**: Approved (pending implementation)
**Scope**: Web frontend (`src/renderer/`) only — no server / API changes

## Goal

Make the Crossfadio Web UI usable on phones (≥ 360px wide) without sacrificing the
existing desktop layout. Users should be able to log in via NCM, browse the player,
plan, chat, and settings tabs, and operate the DJ flow on a phone in portrait mode.

## Non-Goals

- No native app, no PWA install flow, no offline support
- No layout changes for tablets in landscape (≥ 1024px) — they continue to render
  the desktop layout
- No new component library, no design tokens overhaul
- No changes to audio engine, WS protocol, or backend routes
- No new automated tests for pure CSS changes

## High-Level Strategy

1. **Responsive same-code**: one component tree drives both viewports via Tailwind
   responsive classes
2. **Single breakpoint**: `md` = 768px. Below 768 → mobile layout. ≥ 768 → current
   desktop layout
3. **Mobile-first base styles**: default classes target the narrow case; `md:`
   utilities restore desktop behavior
4. **No structural rewrites**: existing component files stay; we add classes and a
   single hook (`useMediaQuery`) plus one conditional render path (NCM auth UI)

## Affected Files

| File | Change kind |
|------|-------------|
| `src/renderer/index.html` | Add `viewport-fit=cover` to viewport meta |
| `src/renderer/App.tsx` | Add `pb-[env(safe-area-inset-bottom)]` to bottom tab nav |
| `src/renderer/lib-hooks.ts` (NEW) | `useMediaQuery` hook |
| `src/renderer/views/Player/PlayerView.tsx` | Header collapse, grid stacking, NCM auth sheet, status panel collapse |
| `src/renderer/components/player/NowPlayingHero.tsx` | Title size + cover spacing tweaks |
| `src/renderer/components/player/PlaybackTimeline.tsx` | Adjacent-track name max-width |
| `src/renderer/components/player/RecommendOverlay.tsx` | Full-width on mobile |
| `src/renderer/views/Plan/PlanView.tsx` | Padding + button label hide on narrow |
| `src/renderer/views/Settings/SettingsView.tsx` | Field grid + outer padding |
| `src/renderer/components/player/ChatPanel.tsx` | Bubble max-width + input padding |

## Detailed Changes

### 1. Foundation

**`src/renderer/index.html`**

Update the viewport meta to opt into safe-area insets:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**`src/renderer/lib-hooks.ts` (new file, ~15 lines)**

```ts
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const get = (): boolean =>
    typeof window !== 'undefined' && window.matchMedia(query).matches;

  const [matches, setMatches] = useState(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener('change', handler);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
```

Used by `PlayerView` to decide whether to render the NCM dropdown vs the full-screen
sheet, and to choose initial collapsed/expanded state for the status panel.

**`src/renderer/App.tsx`**

```diff
- <nav className="flex border-t border-zinc-800 bg-zinc-900">
+ <nav className="flex border-t border-zinc-800 bg-zinc-900 pb-[env(safe-area-inset-bottom)]">
```

### 2. PlayerView — Header

Replace the right-side cluster with a viewport-aware version:

- "今日计划" and "设置" buttons get `hidden md:inline-flex` (mobile users navigate via
  the bottom tab bar; redundant on phone)
- The NCM status chip (with green/red dot + "已登录"/"未登录") stays on both viewports
- The NCM auth UI splits:
  - **Desktop (≥ md)**: existing dropdown panel under the chip (no change)
  - **Mobile (< md)**: tapping the chip opens a full-screen sheet (`fixed inset-0`)
    with a dimmed backdrop, a centered card containing:
    - Close button (top-right, X icon)
    - "二维码登录" / "检查状态" / "登出" buttons (full-width)
    - QR image rendered at ~220px square (vs 112px in the dropdown)
  - Sheet closes via: backdrop click, X button, ESC keypress
  - Body scroll lock while sheet is open: add `overflow-hidden` to `document.body` on
    mount, restore on unmount

The branching is done with `useMediaQuery('(min-width: 768px)')`.

### 3. PlayerView — Grid + Stacking

```diff
- <main className="bg-[radial-gradient(...)] p-6 text-zinc-100">
-   <div className="mx-auto grid max-w-[1480px] grid-cols-12 gap-4">
+ <main className="bg-[radial-gradient(...)] p-4 md:p-6 text-zinc-100">
+   <div className="mx-auto grid max-w-[1480px] grid-cols-1 md:grid-cols-12 gap-4">
```

Header keeps `col-span-1 md:col-span-12`. Left section becomes
`col-span-1 md:col-span-6`, right section the same. On mobile the grid collapses to a
single column and sections stack in DOM order: Hero → Timeline → Transport → Queue →
Status.

### 4. PlayerView — Status Panel Collapse

The right-section status panel currently always renders chips + (optional) debug
expanders. On mobile this is the bulk of vertical space and rarely consulted.

Add internal collapse state:

```ts
const isDesktop = useMediaQuery('(min-width: 768px)');
const [statusExpanded, setStatusExpanded] = useState(isDesktop);
useEffect(() => { setStatusExpanded(isDesktop); }, [isDesktop]);
```

Render two modes inside the existing status panel container:

- **Collapsed (mobile default)**: one line, `text-xs`, format
  `DJ：<djStatusText || '空闲'>　过渡：<segueStatusText || '空闲'>　[展开]`
- **Expanded (desktop default)**: current full layout (status chips, dj log expander,
  segue script expander, "重新开始 DJ 模式" button)

Tapping the row header toggles. The existing nested expanders (`djPickLogExpanded`,
`segueScriptExpanded`) keep their own state and only render when status panel is
expanded.

### 5. PlayerView — Hero + Timeline + Transport tweaks

**`NowPlayingHero.tsx`**

```diff
- <h2 className="text-xl font-semibold leading-tight text-zinc-100">
+ <h2 className="text-lg md:text-xl font-semibold leading-tight text-zinc-100">
```

Cover stays 96×96 (looks fine at 360px width). Outer `p-4` unchanged.

**`PlaybackTimeline.tsx`**

```diff
- <span className="max-w-[160px] truncate text-amber-400/70">
+ <span className="max-w-[40vw] md:max-w-[160px] truncate text-amber-400/70">
- <span className="max-w-[160px] truncate text-violet-400/70">
+ <span className="max-w-[40vw] md:max-w-[160px] truncate text-violet-400/70">
```

**`TransportControls.tsx`**: no change needed (button hit-targets already meet 40px).

**`QueuePanel.tsx`**: no change needed. Outer `p-4` works at 360px, and the inner
`<ul>` already has `max-h-[52vh] overflow-y-auto`, so a long queue scrolls internally
rather than displacing sections below it on the page.

### 6. RecommendOverlay

```diff
- <div className="fixed bottom-20 right-4 z-50 max-w-xs animate-in ...">
+ <div className="fixed bottom-20 right-4 left-4 md:left-auto md:max-w-xs z-50 animate-in ...">
```

On mobile the toast spans `right-4 ↔ left-4` (full width minus 16px each side). On
desktop it preserves the current 320px max-width docked to the right.

### 7. PlanView

```diff
- <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
+ <div className="flex items-center justify-between border-b border-zinc-800 px-4 md:px-6 py-4">
```

Hide the "重新规划" label on narrow screens, keep the icon:

```diff
- {status === 'regenerating' ? <Loader2 ... /> : <RefreshCw ... />}
- 重新规划
+ {status === 'regenerating' ? <Loader2 ... /> : <RefreshCw ... />}
+ <span className="hidden sm:inline">重新规划</span>
```

Content padding `px-4 py-4` already mobile-friendly.

### 8. SettingsView

```diff
- <div className="flex items-center gap-2 border-b border-zinc-800 px-6 py-4">
+ <div className="flex items-center gap-2 border-b border-zinc-800 px-4 md:px-6 py-4">

- <div className="flex-1 space-y-8 px-6 py-6">
+ <div className="flex-1 space-y-8 px-4 py-4 md:px-6 md:py-6">

- <div className="sticky bottom-0 ... px-6 py-4">
+ <div className="sticky bottom-0 ... px-4 md:px-6 py-4">
```

In `Field` / `ReadOnlyField`:

```diff
- <div className="grid grid-cols-[120px_1fr] items-center gap-3">
+ <div className="grid grid-cols-[100px_1fr] md:grid-cols-[120px_1fr] items-center gap-3">
```

### 9. ChatPanel

Only the message bubble width needs adjusting; the existing header / messages / input
paddings (`px-4 py-3`, `px-3 py-2`) are already mobile-friendly and don't need
breakpoint variants.

```diff
- className={`max-w-[80%] rounded-2xl px-3 py-2 ...`}
+ className={`max-w-[85%] md:max-w-[80%] rounded-2xl px-3 py-2 ...`}
```

## Verification Plan

Manual only — pure styling work, no logic branches besides the documented hook.

1. `pnpm check` must pass
2. `pnpm dev:web`; in Chrome devtools, walk every tab at:
   - iPhone SE (375 × 667)
   - Pixel 5 (393 × 851)
   - iPad mini portrait (768 × 1024)
   - Desktop 1280 × 800
3. For each viewport confirm:
   - No horizontal scroll on the document
   - No element clipped or overlapping the bottom tab bar
   - Hero / timeline / transport / queue all visible by scrolling
   - Status panel starts collapsed on mobile, expanded on desktop
   - Tapping the NCM chip on mobile opens a full-screen sheet; QR readable; sheet
     closes via backdrop / X / ESC
   - PlanView "重新规划" icon-only on phone, full label on desktop
   - SettingsView field labels not truncated; save bar fixed at bottom
   - ChatPanel bubbles wrap correctly at 360px width
4. iPhone safe-area: visually inspect on real device or via the iOS simulator if
   available; the `pb-[env(safe-area-inset-bottom)]` should keep tab bar above the
   home indicator

## Implementation Order

Each step is one commit, prefix `style(mobile):` or `feat(mobile):` per Conventional
Commits.

1. **Foundation**: `index.html` viewport, `App.tsx` safe-area, `lib-hooks.ts`
2. **PlayerView header**: hide redundant nav buttons; NCM dropdown ↔ sheet branching
3. **PlayerView grid + status panel**: stacking + collapse logic
4. **Mobile micro-tweaks**: `NowPlayingHero`, `PlaybackTimeline`, `RecommendOverlay`
5. **Other views**: `PlanView`, `SettingsView`, `ChatPanel`
6. **Verify**: walk the manual checklist

## Risks

- **`useMediaQuery` flicker on first render**: initial state derives from
  `window.matchMedia`, but if SSR ever returns a value mismatching client, hydration
  warning may fire. Mitigated by deferring matches read to `useEffect`. We don't SSR
  today, so this is theoretical.
- **NCM sheet body-scroll lock**: must restore `overflow` on unmount even if the user
  navigates away mid-sheet. Use a cleanup function in `useEffect`.
- **Existing dropdown click-outside handler** uses `mousedown`. The mobile sheet uses
  taps; we render a different element so the existing handler doesn't conflict, but
  must be careful not to leave both handlers attached.
