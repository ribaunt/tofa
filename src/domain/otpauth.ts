import type { TotpAccount, TotpAlgorithm } from "./types";
import { decodeBase32 } from "./base32";

const algorithms = new Set<TotpAlgorithm>(["SHA1", "SHA256", "SHA512"]);

export type AccountDraft = Omit<TotpAccount, "id">;

export function normalizeAccountDraft(draft: Partial<AccountDraft>): AccountDraft {
  const issuer = cleanText(draft.issuer);
  const label = cleanText(draft.label);
  const secret = cleanText(draft.secret).replace(/\s/g, "").toUpperCase();
  const algorithm = normalizeAlgorithm(draft.algorithm ?? "SHA1");
  const digits = normalizeInteger(draft.digits, 6, "digits");
  const period = normalizeInteger(draft.period, 30, "period");

  if (!issuer) throw new Error("Issuer is required.");
  if (!label) throw new Error("Label is required.");
  if (!secret) throw new Error("Secret is required.");
  decodeBase32(secret);
  if (digits < 6 || digits > 8) throw new Error("Digits must be between 6 and 8.");
  if (period < 10 || period > 120) throw new Error("Period must be between 10 and 120 seconds.");

  return { issuer, label, secret, algorithm, digits, period };
}

export function createAccount(draft: Partial<AccountDraft>): TotpAccount {
  return {
    id: crypto.randomUUID(),
    ...normalizeAccountDraft(draft),
  };
}

export function parseOtpAuthUri(uri: string): TotpAccount {
  let parsed: URL;

  try {
    parsed = new URL(uri.trim());
  } catch {
    throw new Error("Invalid otpauth URI.");
  }

  if (parsed.protocol !== "otpauth:" || parsed.hostname !== "totp") {
    throw new Error("Only otpauth://totp URIs are supported.");
  }

  const rawLabel = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const [labelIssuer, ...labelParts] = rawLabel.split(":");
  const labelFromPath = labelParts.length > 0 ? labelParts.join(":") : labelIssuer;
  const issuerFromPath = labelParts.length > 0 ? labelIssuer : "";
  const issuer = parsed.searchParams.get("issuer") || issuerFromPath;
  const secret = parsed.searchParams.get("secret") || "";
  const algorithm = parsed.searchParams.get("algorithm") || "SHA1";
  const digits = parsed.searchParams.get("digits");
  const period = parsed.searchParams.get("period");

  return createAccount({
    issuer,
    label: labelFromPath,
    secret,
    algorithm: algorithm.toUpperCase() as TotpAlgorithm,
    digits: digits ? Number.parseInt(digits, 10) : 6,
    period: period ? Number.parseInt(period, 10) : 30,
  });
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAlgorithm(value: string): TotpAlgorithm {
  const algorithm = value.toUpperCase() as TotpAlgorithm;

  if (!algorithms.has(algorithm)) {
    throw new Error("Algorithm must be SHA1, SHA256, or SHA512.");
  }

  return algorithm;
}

function normalizeInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;

  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isInteger(number)) {
    throw new Error(`${field} must be a whole number.`);
  }

  return number;
}
