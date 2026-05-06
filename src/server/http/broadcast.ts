import type { WebSocketServer, WebSocket } from 'ws';

type BroadcastClient = WebSocket & { authenticated?: boolean; userId?: string };

let wss: WebSocketServer | null = null;

export function registerWss(instance: WebSocketServer): void {
  wss = instance;
}

export function broadcast(payload: unknown): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients as Set<BroadcastClient>) {
    if (client.readyState === 1 /* OPEN */ && client.authenticated) {
      client.send(data);
    }
  }
}

export function broadcastToUser(userId: string, payload: unknown): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients as Set<BroadcastClient>) {
    if (
      client.readyState === 1 /* OPEN */ &&
      client.authenticated &&
      client.userId === userId
    ) {
      client.send(data);
    }
  }
}
