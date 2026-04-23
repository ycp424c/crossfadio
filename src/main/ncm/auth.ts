import { NcmClient } from './client';
import { SecretStore } from '@main/security';

const NCM_COOKIE_KEY = 'ncm.cookie';

export type NcmSession = {
  hasCookie: boolean;
  profile: unknown | null;
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

  async checkQr(key: string): Promise<{ code: number; message: string; hasCookie: boolean }> {
    const result = await this.client.checkLoginQr(key);

    if (result.code === 803 && result.cookie) {
      this.cookie = result.cookie;
      this.secrets.set(NCM_COOKIE_KEY, result.cookie);
    }

    return {
      code: result.code,
      message: result.message,
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
