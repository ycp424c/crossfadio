import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { SessionToken } from '@shared/types';
import { wsAuthSchema } from '@shared/schema';

export function setupWsServer(server: Server, sessionToken: SessionToken): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(String(raw));
          const authResult = wsAuthSchema.safeParse(parsed);

          if (!authenticated) {
            if (!authResult.success || authResult.data.token !== sessionToken) {
              ws.close(4001, 'unauthorized');
              return;
            }

            authenticated = true;
            ws.send(JSON.stringify({ type: 'auth.ok' }));
            return;
          }

          ws.send(JSON.stringify({ type: 'noop', received: parsed?.type ?? 'unknown' }));
        } catch {
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
