import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, MessageCircle } from 'lucide-react';
import { addSseListener, streamChat } from '@renderer/sse/client';
import { getRecentChatMessages } from '@renderer/api';
import { getUserScrollBehavior } from '@renderer/lib-motion';

type Message = {
  id: number;
  role: 'user' | 'dj';
  text: string;
  pending?: boolean;
  phase?: 'thinking' | 'streaming';
};
type RecommendEvent = { type: string; data: Record<string, unknown> };

const MAX_MESSAGES = 200;
let msgId = 0;

function appendMessages(prev: Message[], next: Message[]): Message[] {
  const combined = [...prev, ...next];
  return combined.length > MAX_MESSAGES ? combined.slice(combined.length - MAX_MESSAGES) : combined;
}

function appendIntentNotice(prev: Message[], data: unknown): Message[] {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const text = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!text) return prev;
  const notice: Message = { id: ++msgId, role: 'dj', text };
  const last = prev[prev.length - 1];
  return last?.pending
    ? [...prev.slice(0, -1), notice, last]
    : appendMessages(prev, [notice]);
}

export function ChatPanel({
  authToken,
  onRecommendEvent
}: {
  authToken: string | null;
  onRecommendEvent?: (evt: RecommendEvent) => void;
}): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const accountGenerationRef = useRef(0);

  useEffect(() => {
    const generation = ++accountGenerationRef.current;
    setMessages([]);
    setInput('');
    setSending(false);
    if (!authToken) return;

    const unsubscribe = addSseListener((type, data, eventToken) => {
      if (accountGenerationRef.current !== generation || eventToken !== authToken) return;
      if (type === 'chat.intent.notice') {
        setMessages((prev) => appendIntentNotice(prev, data));
      }
    });
    void getRecentChatMessages(50, { authToken }).then((msgs) => {
      if (accountGenerationRef.current !== generation) return;
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
    return unsubscribe;
  }, [authToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: getUserScrollBehavior() });
  }, [messages]);

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text || sending || !authToken) return;
    const generation = accountGenerationRef.current;
    const requestToken = authToken;
    const thinkingId = ++msgId;
    setMessages((prev) => appendMessages(prev, [
      { id: ++msgId, role: 'user', text },
      { id: thinkingId, role: 'dj', text: '', pending: true, phase: 'thinking' }
    ]));
    setInput('');
    setSending(true);

    try {
      for await (const { type, data } of streamChat(text, requestToken)) {
        if (accountGenerationRef.current !== generation) break;
        if (type === 'chat.delta') {
          const delta = String(data.say ?? '');
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.pending) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.phase === 'thinking' ? delta : last.text + delta, phase: 'streaming' }
              ];
            }
            return [...prev, { id: ++msgId, role: 'dj', text: delta, pending: true, phase: 'streaming' }];
          });
        } else if (type === 'chat.intent.notice') {
          setMessages((prev) => appendIntentNotice(prev, data));
        } else if (type === 'chat.done') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.pending) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: String(data.say ?? last.text), pending: false, phase: undefined }
              ];
            }
            return [...prev, { id: ++msgId, role: 'dj', text: String(data.say ?? ''), pending: false }];
          });
          setSending(false);
        } else if (type === 'chat.error') {
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
          break;
        } else if (type.startsWith('chat.recommend.')) {
          onRecommendEvent?.({ type, data });
        }
      }
    } catch {
      if (accountGenerationRef.current !== generation) return;
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
    } finally {
      if (accountGenerationRef.current === generation) setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col text-zinc-100">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <MessageCircle className="h-4 w-4 text-cyan-300" />
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
              className={`max-w-[85%] md:max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-cyan-700 text-white'
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
          className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-1 focus:ring-cyan-400/60"
          disabled={sending || !authToken}
        />
        <button
          aria-label="发送消息"
          onClick={handleSend}
          disabled={sending || !authToken || !input.trim()}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-cyan-300 hover:bg-zinc-800 disabled:opacity-40 transition"
          type="button"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
