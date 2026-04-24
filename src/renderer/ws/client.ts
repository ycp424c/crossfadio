type WsMessage = Record<string, unknown> & { type: string };
type MessageHandler = (msg: WsMessage) => void;

let socket: WebSocket | null = null;
let sessionToken: string | null = null;
const handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function initWsClient(token: string): void {
  sessionToken = token;
  connect();
}

export function sendChatMessage(text: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'chat', text }));
  }
}

export function onWsMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function connect(): void {
  if (!sessionToken) return;
  const wsUrl = window.location.origin.replace(/^http/, 'ws') + '/ws';
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    socket!.send(JSON.stringify({ type: 'auth', token: sessionToken }));
  });

  socket.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(String(evt.data)) as WsMessage;
      for (const h of handlers) h(msg);
    } catch {
      // ignore malformed messages
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  });

  socket.addEventListener('error', () => {
    socket?.close();
  });
}

export function closeWsClient(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}
