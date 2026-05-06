import { jwtVerify } from 'jose';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { wsAuthSchema } from '../../shared/schema.js';
import { registerWss } from './broadcast.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { getUserById } from '../store/users.js';
import { deriveKey, decrypt } from '../crypto.js';
import { NcmClient } from '../ncm/client.js';

export type ChatMessageHandler = (ws: WebSocket & { userId: string; ncmClient: NcmClient }, text: string) => void;
export type CancelRecommendHandler = (jobId: string) => void;

type WsOptions = {
  ncmBaseUrl: string;
  onChatMessage?: ChatMessageHandler;
  onCancelRecommend?: CancelRecommendHandler;
};

export function setupWsServer(server: Server, options: WsOptions): WebSocketServer {
  const logger = getLogger();
  const wss = new WebSocketServer({ noServer: true });
  registerWss(wss);

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') { socket.destroy(); return; }

    wss.handleUpgrade(request, socket, head, (ws) => {
      type ExtWs = WebSocket & { authenticated?: boolean; userId?: string; ncmClient?: NcmClient };
      const extWs = ws as ExtWs;
      extWs.authenticated = false;

      ws.on('message', async (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as unknown;

          if (!extWs.authenticated) {
            const authResult = wsAuthSchema.safeParse(parsed);
            if (!authResult.success) { ws.close(4001, 'unauthorized'); return; }

            const token = authResult.data.token;
            try {
              const config = getConfig();
              const secret = new TextEncoder().encode(config.jwtSecret);
              const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
              if (typeof payload.sub !== 'string') throw new Error('no sub');

              const user = getUserById(payload.sub);
              if (!user) { ws.close(4001, 'user not found'); return; }

              const key = deriveKey(config.jwtSecret);
              const cookie = decrypt(user.ncm_cookie, key);
              extWs.userId = payload.sub;
              extWs.ncmClient = new NcmClient(options.ncmBaseUrl, { getCookie: () => cookie });
              extWs.authenticated = true;
              ws.send(JSON.stringify({ type: 'auth.ok' }));
            } catch {
              ws.close(4001, 'unauthorized');
            }
            return;
          }

          const msg = parsed as Record<string, unknown>;
          if (msg.type === 'chat' && typeof msg.text === 'string') {
            options.onChatMessage?.(extWs as WebSocket & { userId: string; ncmClient: NcmClient }, msg.text);
            return;
          }
          if (msg.type === 'chat.cancel-recommend' && typeof msg.jobId === 'string') {
            options.onCancelRecommend?.(msg.jobId);
            return;
          }
          ws.send(JSON.stringify({ type: 'noop', received: msg.type ?? 'unknown' }));
        } catch {
          logger.warn('WS bad message, closing');
          ws.close(1003, 'bad message');
        }
      });

      ws.on('error', () => ws.close());
    });
  });

  return wss;
}
