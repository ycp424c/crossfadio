import { useEffect, useState } from 'react';
import { Radio, Settings2, CalendarDays, MessageCircle } from 'lucide-react';
import { PlayerView } from '@renderer/views/Player/PlayerView';
import { SettingsView } from '@renderer/views/Settings/SettingsView';
import { PlanView } from '@renderer/views/Plan/PlanView';
import { ChatPanel } from '@renderer/components/player/ChatPanel';
import { RecommendOverlay } from '@renderer/components/player/RecommendOverlay';
import { getRuntimeInfo, getStoredToken } from '@renderer/api';
import { initWsClient } from '@renderer/ws/client';

type Tab = 'player' | 'plan' | 'chat' | 'settings';

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('player');

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      initWsClient(token);
    }
    // Ping runtime to check service health
    void getRuntimeInfo().catch(() => {});
  }, []);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Main content — all views stay mounted so audio and chat history persist */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ display: tab === 'player' ? 'block' : 'none' }}>
          <PlayerView onNavigate={setTab} />
        </div>
        <div style={{ display: tab === 'plan' ? 'block' : 'none' }}>
          <PlanView />
        </div>
        <div style={{ display: tab === 'chat' ? 'flex' : 'none' }} className="h-full flex-col">
          <ChatPanel />
        </div>
        <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
          <SettingsView />
        </div>
      </div>

      {/* Bottom tab bar */}
      <nav className="flex border-t border-zinc-800 bg-zinc-900">
        <TabButton active={tab === 'player'} onClick={() => setTab('player')} icon={<Radio className="h-4 w-4" />} label="播放" />
        <TabButton active={tab === 'plan'} onClick={() => setTab('plan')} icon={<CalendarDays className="h-4 w-4" />} label="计划" />
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageCircle className="h-4 w-4" />} label="聊天" />
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Settings2 className="h-4 w-4" />} label="设置" />
      </nav>

      <RecommendOverlay />
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
