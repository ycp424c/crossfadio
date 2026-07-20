import { getConfig } from '../config.js';
import { decrypt, deriveKey } from '../crypto.js';
import { broadcastToUser } from '../http/broadcast.js';
import { getLogger } from '../logger.js';
import { NcmClient } from '../ncm/client.js';
import { resolveTrackIdentity } from '../ncm/resolver.js';
import { getUserById } from '../store/users.js';
import type { ExplicitExclusionResolutionRecord } from '../store/explicit-exclusion-resolutions.js';
import {
  createExplicitExclusionResolutionWorker,
  type ExplicitExclusionResolutionWorker
} from './explicit-exclusion-resolution-worker.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';

type WorkerOptions = Parameters<typeof createExplicitExclusionResolutionWorker>[0];
type WorkerLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export type ExplicitExclusionResolutionRuntime = {
  start(): void;
  stop(): Promise<void>;
};

export function createExplicitExclusionResolutionRuntime(input: {
  ncmBaseUrl: string;
  createWorker?: (options: WorkerOptions) => ExplicitExclusionResolutionWorker;
  logger?: WorkerLogger;
}): ExplicitExclusionResolutionRuntime {
  const worker = (input.createWorker ?? createExplicitExclusionResolutionWorker)({
    async resolve(record, signal) {
      const user = getUserById(record.userId);
      if (!user) return { status: 'unavailable' };
      const cookie = decrypt(user.ncm_cookie, deriveKey(getConfig().jwtSecret));
      const client = new NcmClient(input.ncmBaseUrl, { getCookie: () => cookie });
      return resolveTrackIdentity({
        title: record.queryTitle,
        artist: record.queryArtist
      }, client, signal);
    },
    onStatus: publishResolutionStatus,
    onError(error) {
      (input.logger ?? getLogger()).warn({
        error: safeOperationalError(error, 'explicit_exclusion_resolution_worker_failed')
      }, 'Explicit Exclusion resolution worker failed');
    }
  });

  return {
    start() {
      worker.start();
    },
    stop() {
      return worker.stop();
    }
  };
}

function publishResolutionStatus(record: ExplicitExclusionResolutionRecord): void {
  if (record.status === 'succeeded') {
    broadcastToUser(record.userId, {
      type: 'chat.intent.notice',
      kind: 'track_exclusion_resolution_succeeded',
      exclusionId: record.resolvedExclusionId,
      message: `已确认《${record.queryTitle}》的唯一版本，硬禁播现已生效。`
    });
    return;
  }
  if (record.status === 'dead') {
    broadcastToUser(record.userId, {
      type: 'chat.intent.notice',
      kind: 'track_exclusion_resolution_dead',
      exclusionId: record.exclusionId,
      message: `在确认期限内仍无法唯一识别《${record.queryTitle}》，本次没有启用硬禁播；请补充艺人后重试。`
    });
  }
}
