type WsMessage = Record<string, unknown> & { type: string };
type MessageHandler = (msg: WsMessage) => void;

let socket: WebSocket | null = null;
let sessionToken: string | null = null;
const handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = true;

export function initWsClient(token: string): void {
  if (
    sessionToken === token &&
    (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  sessionToken = token;
  shouldReconnect = true;
  connect();
}

export function sendChatMessage(text: string): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'chat', text }));
    return true;
  }
  return false;
}

export function sendCancelRecommend(jobId: string): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'chat.cancel-recommend', jobId }));
    return true;
  }
  return false;
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
    if (!shouldReconnect) return;
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
  shouldReconnect = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}
