import type { WebSocketServer, WebSocket } from 'ws';

let wss: WebSocketServer | null = null;

export function registerWss(instance: WebSocketServer): void {
  wss = instance;
}

export function broadcast(payload: unknown): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients as Set<WebSocket & { authenticated?: boolean }>) {
    if (client.readyState === 1 /* OPEN */ && client.authenticated) {
      client.send(data);
    }
  }
}
