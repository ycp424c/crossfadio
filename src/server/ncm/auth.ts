import { SignJWT } from 'jose';
import type { NcmClient } from './client.js';
import { NCM_QR_CODE, NCM_QR_HINT, type NcmQrCode, type NcmQrHint } from '../../shared/schema.js';
import { getConfig } from '../config.js';
import { deriveKey, encrypt } from '../crypto.js';
import { upsertUser, recordBlockedAttempt } from '../store/users.js';
import { getUserAccessStatus } from '../store/user-access-controls.js';
import { ensureUserCorpus } from '../user-corpus/bootstrap.js';

const QR_MESSAGE: Record<NcmQrCode, string> = {
  [NCM_QR_CODE.EXPIRED]: '二维码已过期，请刷新重试',
  [NCM_QR_CODE.WAITING]: '等待扫码',
  [NCM_QR_CODE.SCANNED]: '已扫码，请在网易云 App 确认登录',
  [NCM_QR_CODE.AUTHORIZED]: '登录成功'
};

export type NcmQrStatusResult = {
  code: NcmQrCode;
  hint: NcmQrHint;
  message: string;
  hasCookie: boolean;
  token?: string;
};

export class NcmAuthService {
  constructor(private readonly client: NcmClient) {}

  async createQr(): Promise<{ key: string; qrimg: string; qrurl: string }> {
    return this.client.createLoginQr();
  }

  async checkQr(key: string): Promise<NcmQrStatusResult> {
    const result = await this.client.checkLoginQr(key);
    const code = normalizeQrCode(result.code);

    if (code !== NCM_QR_CODE.AUTHORIZED || !result.cookie) {
      return {
        code,
        hint: NCM_QR_HINT[code],
        message: result.message || QR_MESSAGE[code],
        hasCookie: false
      };
    }

    // QR authorized — get NCM user ID with the just-issued cookie.
    const authedClient = this.client.withCookie(result.cookie);
    const loginStatus = await authedClient.getLoginStatus();
    const profile = (loginStatus as any)?.data?.profile ?? null;
    const ncmId = String((profile as any)?.userId ?? '');

    if (!ncmId) {
      return {
        code: NCM_QR_CODE.EXPIRED,
        hint: 'expired',
        message: '无法获取用户信息，请重试',
        hasCookie: false
      };
    }

    // Safety suspension is independent of priority membership and blocks login.
    if (getUserAccessStatus(ncmId) === 'suspended') {
      const profileJson = profile ? JSON.stringify(profile) : null;
      recordBlockedAttempt({ ncmId, profileJson });
      return {
        code: NCM_QR_CODE.AUTHORIZED,
        hint: 'forbidden',
        message: '账号已被暂停使用，请联系管理员',
        hasCookie: false
      };
    }

    // Persist encrypted cookie. Every valid NCM account may authenticate;
    // allowlist membership only grants the priority resource tier.
    const config = getConfig();
    const keyDerived = deriveKey(config.jwtSecret);
    const encryptedCookie = encrypt(result.cookie, keyDerived);
    const profileJson = profile ? JSON.stringify(profile) : null;
    upsertUser({ ncmId, encryptedCookie, profileJson });
    ensureUserCorpus(ncmId);

    // Sign JWT
    const secret = new TextEncoder().encode(config.jwtSecret);
    const ttlDays = config.jwtTtlDays;
    const token = await new SignJWT({ sub: ncmId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${ttlDays}d`)
      .sign(secret);

    return {
      code: NCM_QR_CODE.AUTHORIZED,
      hint: 'authorized',
      message: '登录成功',
      hasCookie: true,
      token
    };
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
