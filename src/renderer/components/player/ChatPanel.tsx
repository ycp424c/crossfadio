import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, MessageCircle } from 'lucide-react';
import { sendChatMessage, onWsMessage } from '@renderer/ws/client';
import { getRecentChatMessages } from '@renderer/api';

type Message = {
  id: number;
  role: 'user' | 'dj';
  text: string;
  pending?: boolean;
  phase?: 'thinking' | 'streaming';
};

const MAX_MESSAGES = 200;
let msgId = 0;

function appendMessages(prev: Message[], next: Message[]): Message[] {
  const combined = [...prev, ...next];
  return combined.length > MAX_MESSAGES ? combined.slice(combined.length - MAX_MESSAGES) : combined;
}

export function ChatPanel(): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const historyLoadedRef = useRef(false);

  useEffect(() => {
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    void getRecentChatMessages(50).then((msgs) => {
      const historical: Message[] = msgs
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: ++msgId,
          role: m.role === 'user' ? 'user' : 'dj',
          text: m.content
        }));
      if (historical.length > 0) {
        setMessages(historical);
      }
    }).catch(() => {
      // History load is best-effort
    });
  }, []);

  useEffect(() => {
    const unsub = onWsMessage((msg) => {
      if (msg.type === 'chat.delta') {
        const delta = String(msg.say ?? '');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.pending) {
            return [
              ...prev.slice(0, -1),
              { ...last, text: last.phase === 'thinking' ? delta : last.text + delta, phase: 'streaming' }
            ];
          }
          const id = ++msgId;
          return [...prev, { id, role: 'dj', text: delta, pending: true, phase: 'streaming' }];
        });
      } else if (msg.type === 'chat.done') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.pending) {
            return [
              ...prev.slice(0, -1),
              { ...last, text: String(msg.say ?? last.text), pending: false, phase: undefined }
            ];
          }
          return [...prev, { id: ++msgId, role: 'dj', text: String(msg.say ?? ''), pending: false }];
        });
        setSending(false);
      } else if (msg.type === 'chat.error') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.pending) {
            return [
              ...prev.slice(0, -1),
              { ...last, text: '出错了，请稍后再试。', pending: false, phase: undefined }
            ];
          }
          return [
            ...prev,
            { id: ++msgId, role: 'dj', text: '出错了，请稍后再试。', pending: false }
          ];
        });
        setSending(false);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSend(): void {
    const text = input.trim();
    if (!text || sending) return;
    const thinkingId = ++msgId;
    setMessages((prev) => appendMessages(prev, [
      { id: ++msgId, role: 'user', text },
      { id: thinkingId, role: 'dj', text: '', pending: true, phase: 'thinking' }
    ]));
    setInput('');
    setSending(true);
    if (!sendChatMessage(text)) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { id: thinkingId, role: 'dj', text: '聊天连接还没准备好，请稍后再试。', pending: false }
      ]);
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <MessageCircle className="h-4 w-4 text-indigo-400" />
        <span className="text-sm font-medium">和 DJ 聊天</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-zinc-500 text-center mt-8">
            试试说"想要再安静一点"或"来首 Rap"
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-100'
              } ${msg.pending ? 'opacity-80' : ''}`}
            >
              {msg.pending && msg.phase === 'thinking' && !msg.text ? 'DJ 正在思考中' : msg.text}
              {msg.pending && <span className="animate-pulse ml-0.5">▎</span>}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="告诉 DJ 你的心情…"
          className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-1 focus:ring-indigo-500"
          disabled={sending}
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          className="rounded-lg p-2 text-indigo-400 hover:bg-zinc-800 disabled:opacity-40 transition"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
