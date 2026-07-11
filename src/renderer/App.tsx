import { useEffect, useState } from 'react';
import { Radio, Settings2, MessageCircle } from 'lucide-react';
import { PlayerView } from '@renderer/views/Player/PlayerView';
import { SettingsView } from '@renderer/views/Settings/SettingsView';
import { ChatPanel } from '@renderer/components/player/ChatPanel';
import { RecommendOverlay } from '@renderer/components/player/RecommendOverlay';
import { getRuntimeInfo, getStoredToken } from '@renderer/api';
import { initSseEvents } from '@renderer/sse/client';

type Tab = 'player' | 'chat' | 'settings';
type RecommendEvent = { type: string; data: Record<string, unknown> };

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('player');
  const [recommendEvent, setRecommendEvent] = useState<RecommendEvent | null>(null);

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      initSseEvents(token);
    }
    // Ping runtime to check service health
    void getRuntimeInfo().catch(() => {});
  }, []);

  return (
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] flex-col bg-zinc-950 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-zinc-100">
      {/* Main content — all views stay mounted so audio and chat history persist */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ display: tab === 'player' ? 'block' : 'none' }}>
          <PlayerView onNavigate={setTab} />
        </div>
        <div style={{ display: tab === 'chat' ? 'flex' : 'none' }} className="h-full flex-col">
          <ChatPanel onRecommendEvent={setRecommendEvent} />
        </div>
        <div style={{ display: tab === 'settings' ? 'block' : 'none' }} className="h-full">
          <SettingsView />
        </div>
      </div>

      {/* Bottom tab bar */}
      <nav className="flex border-t border-zinc-800 bg-zinc-900 pb-[env(safe-area-inset-bottom)]">
        <TabButton active={tab === 'player'} onClick={() => setTab('player')} icon={<Radio className="h-4 w-4" />} label="播放" />
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageCircle className="h-4 w-4" />} label="聊天" />
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Settings2 className="h-4 w-4" />} label="设置" />
      </nav>

      <RecommendOverlay recommendEvent={recommendEvent} />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition ${
        active ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
