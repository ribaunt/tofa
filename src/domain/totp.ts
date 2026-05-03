import { createHmac } from "node:crypto";
import { decodeBase32 } from "./base32";
import type { TotpAccount, TotpAlgorithm, TotpCode } from "./types";

const algorithmMap: Record<TotpAlgorithm, string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
};

export function generateTotp(account: TotpAccount, now = Date.now()): TotpCode {
  const counter = Math.floor(now / 1000 / account.period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithmMap[account.algorithm], decodeBase32(account.secret))
    .update(counterBuffer)
    .digest();

  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const modulo = 10 ** account.digits;
  const code = (binary % modulo).toString().padStart(account.digits, "0");
  const remainingSeconds = account.period - Math.floor(now / 1000) % account.period;

  return { code, remainingSeconds };
}
