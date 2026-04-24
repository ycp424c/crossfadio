import type { NcmClient } from './client.js';
import type { SecretStore } from '../security.js';
import { NCM_QR_CODE, NCM_QR_HINT, type NcmQrCode, type NcmQrHint } from '../../shared/schema.js';

const NCM_COOKIE_KEY = 'ncm.cookie';

const QR_MESSAGE: Record<NcmQrCode, string> = {
  [NCM_QR_CODE.EXPIRED]: '二维码已过期，请刷新重试',
  [NCM_QR_CODE.WAITING]: '等待扫码',
  [NCM_QR_CODE.SCANNED]: '已扫码，请在网易云 App 确认登录',
  [NCM_QR_CODE.AUTHORIZED]: '登录成功'
};

export type NcmSession = {
  hasCookie: boolean;
  profile: unknown | null;
};

export type NcmQrStatusResult = {
  code: NcmQrCode;
  hint: NcmQrHint;
  message: string;
  hasCookie: boolean;
};

export class NcmAuthService {
  private cookie: string | null;

  constructor(
    private readonly client: NcmClient,
    private readonly secrets: SecretStore
  ) {
    this.cookie = this.secrets.get(NCM_COOKIE_KEY);
  }

  getCookie(): string | null {
    return this.cookie;
  }

  async createQr(): Promise<{ key: string; qrimg: string; qrurl: string }> {
    return this.client.createLoginQr();
  }

  async checkQr(key: string): Promise<NcmQrStatusResult> {
    const result = await this.client.checkLoginQr(key);
    const code = normalizeQrCode(result.code);

    if (code === NCM_QR_CODE.AUTHORIZED && result.cookie) {
      this.cookie = result.cookie;
      this.secrets.set(NCM_COOKIE_KEY, result.cookie);
    }

    return {
      code,
      hint: NCM_QR_HINT[code],
      message: result.message || QR_MESSAGE[code],
      hasCookie: Boolean(this.cookie)
    };
  }

  async getSession(): Promise<NcmSession> {
    if (!this.cookie) {
      return { hasCookie: false, profile: null };
    }

    try {
      const loginStatus = await this.client.getLoginStatus();
      const profile = (loginStatus as any)?.data?.profile ?? null;
      return {
        hasCookie: true,
        profile
      };
    } catch {
      return {
        hasCookie: true,
        profile: null
      };
    }
  }

  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } finally {
      this.cookie = null;
      this.secrets.remove(NCM_COOKIE_KEY);
    }
  }
}

function normalizeQrCode(raw: number): NcmQrCode {
  switch (raw) {
    case NCM_QR_CODE.EXPIRED:
    case NCM_QR_CODE.WAITING:
    case NCM_QR_CODE.SCANNED:
    case NCM_QR_CODE.AUTHORIZED:
      return raw;
    default:
      return NCM_QR_CODE.EXPIRED;
  }
}
