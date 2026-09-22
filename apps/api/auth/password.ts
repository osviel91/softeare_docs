import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<{
  salt: string;
  hash: string;
}> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(password, salt, KEY_LENGTH);
  return {
    salt: salt.toString("base64url"),
    hash: Buffer.from(derived as Buffer).toString("base64url"),
  };
}

export async function verifyPassword(
  password: string,
  saltValue: string,
  hashValue: string,
): Promise<boolean> {
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const derived = Buffer.from(
      await deriveKey(password, salt, expected.length),
    );
    return (
      expected.length === derived.length && timingSafeEqual(expected, derived)
    );
  } catch {
    return false;
  }
}
