import { describe, expect, it } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../../src/server/crypto';

describe('crypto', () => {
  const key = deriveKey('test-secret-key-for-unit-tests');

  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = 'MUSIC_U=test_cookie_value_12345;';
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('encrypt produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input';
    expect(encrypt(plaintext, key)).not.toBe(encrypt(plaintext, key));
  });

  it('decrypt throws on tampered ciphertext', () => {
    const ciphertext = encrypt('hello', key);
    const tampered = ciphertext.slice(0, -4) + 'XXXX';
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('decrypt throws on wrong key', () => {
    const ciphertext = encrypt('hello', key);
    const wrongKey = deriveKey('different-secret');
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });
});
