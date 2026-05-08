import type { Response } from 'express';

/** 初始化 SSE 响应头 */
export function initSseRes(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'   // 禁用 nginx 缓冲
  });
}

/** 写入一条 SSE 事件，自动处理多行 data（\n → \ndata:） */
export function writeSseEvent(res: Response, event: string, data: unknown): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = [
    `event: ${event}`,
    ...payload.split('\n').map((line) => `data: ${line}`),
    ''  // 空行表示事件结束
  ];
  res.write(lines.join('\n') + '\n');
}

/** 写入 SSE comment（心跳） */
export function writeSseComment(res: Response, text: string): void {
  res.write(`: ${text}\n\n`);
}

/** 发送 done 事件并关闭连接 */
export function endSse(res: Response, event: string, data: unknown): void {
  writeSseEvent(res, event, data);
  res.end();
}
