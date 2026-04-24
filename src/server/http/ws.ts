import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { SessionToken } from '../../shared/types.js';
import { wsAuthSchema } from '../../shared/schema.js';
import { registerWss } from './broadcast.js';
import { getLogger } from '../logger.js';

export type ChatMessageHandler = (ws: WebSocket, text: string) => void;

type WsOptions = {
  sessionToken: SessionToken;
  onChatMessage?: ChatMessageHandler;
};

export function setupWsServer(server: Server, options: WsOptions): WebSocketServer;
/** @deprecated Pass options object */
export function setupWsServer(server: Server, sessionToken: SessionToken): WebSocketServer;
export function setupWsServer(
  server: Server,
  optionsOrToken: WsOptions | SessionToken
): WebSocketServer {
  const opts: WsOptions =
    typeof optionsOrToken === 'string'
      ? { sessionToken: optionsOrToken }
      : optionsOrToken;

  const logger = getLogger();
  const wss = new WebSocketServer({ noServer: true });
  registerWss(wss);

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const extWs = ws as WebSocket & { authenticated?: boolean };
      extWs.authenticated = false;

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as unknown;

          if (!extWs.authenticated) {
            const authResult = wsAuthSchema.safeParse(parsed);
            if (!authResult.success || authResult.data.token !== opts.sessionToken) {
              ws.close(4001, 'unauthorized');
              return;
            }
            extWs.authenticated = true;
            ws.send(JSON.stringify({ type: 'auth.ok' }));
            return;
          }

          const msg = parsed as Record<string, unknown>;
          if (msg.type === 'chat' && typeof msg.text === 'string') {
            opts.onChatMessage?.(ws, msg.text);
            return;
          }

          ws.send(JSON.stringify({ type: 'noop', received: msg.type ?? 'unknown' }));
        } catch {
          logger.warn('WS bad message, closing');
          ws.close(1003, 'bad message');
        }
      });

      ws.on('error', () => {
        ws.close();
      });
    });
  });

  return wss;
}
