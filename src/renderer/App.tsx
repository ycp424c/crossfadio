import { useState } from 'react';
import { Radio, Settings2 } from 'lucide-react';
import { PlayerView } from '@renderer/views/Player/PlayerView';
import { SettingsView } from '@renderer/views/Settings/SettingsView';

type Tab = 'player' | 'settings';

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('player');

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Main content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'player' && <PlayerView />}
        {tab === 'settings' && <SettingsView />}
      </div>

      {/* Bottom tab bar */}
      <nav className="flex border-t border-zinc-800 bg-zinc-900">
        <TabButton active={tab === 'player'} onClick={() => setTab('player')} icon={<Radio className="h-4 w-4" />} label="播放" />
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Settings2 className="h-4 w-4" />} label="设置" />
      </nav>
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
