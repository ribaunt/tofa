import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings, ColorSchemeId, ThemeMode, TotpAccount, VaultData, VaultFile } from "./types";

const kdfParams = {
  N: 32768,
  r: 8,
  p: 1,
};

export const defaultSettings: AppSettings = {
  theme: "dark",
  colorScheme: "terminal",
  customColors: {
    active: "#d7f8a7",
    bg: "#080d0c",
    border: "#355045",
    panel: "#101815",
    text: "#d8e5dd",
  },
  security: {
    hideConfidentialValues: true,
    programmableApiEnabled: false,
  },
};

export function getDefaultVaultPath(): string {
  const home = process.env.HOME || process.cwd();

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "tofa", "vault.json");
  }

  const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "tofa", "vault.json");
}

export async function vaultExists(path = getDefaultVaultPath()): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function initializeVault(password: string, path = getDefaultVaultPath()): Promise<void> {
  await saveVault(password, [], path);
}

export async function loadVault(password: string, path = getDefaultVaultPath()): Promise<VaultData> {
  const file = JSON.parse(await readFile(path, "utf8")) as VaultFile;
  const key = deriveKey(password, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));

  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));

  try {
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "base64")),
      decipher.final(),
    ]);
    const data = JSON.parse(decrypted.toString("utf8")) as VaultData;

    return {
      accounts: Array.isArray(data.accounts) ? data.accounts.map(normalizeStoredAccount) : [],
      settings: normalizeSettings(data.settings),
    };
  } catch {
    throw new Error("Could not unlock vault. Check the password or vault file.");
  }
}

export async function saveVault(
  password: string,
  accounts: TotpAccount[],
  settingsOrPath: AppSettings | string = defaultSettings,
  path = getDefaultVaultPath(),
): Promise<void> {
  if (!password) throw new Error("Password is required.");
  const settings = typeof settingsOrPath === "string" ? defaultSettings : settingsOrPath;
  const vaultPath = typeof settingsOrPath === "string" ? settingsOrPath : path;

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt, kdfParams);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ accounts, settings: normalizeSettings(settings) }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const file: VaultFile = {
    version: 1,
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64"),
      ...kdfParams,
    },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };

  await mkdir(dirname(vaultPath), { recursive: true });
  await writeFile(vaultPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export async function changeVaultPassword(
  oldPassword: string,
  newPassword: string,
  path = getDefaultVaultPath(),
): Promise<void> {
  const { accounts, settings } = await loadVault(oldPassword, path);
  await saveVault(newPassword, accounts, settings, path);
}

function normalizeSettings(settings?: Partial<AppSettings>): AppSettings {
  const theme = isTheme(settings?.theme) ? settings.theme : defaultSettings.theme;
  const colorScheme = isColorScheme(settings?.colorScheme) ? settings.colorScheme : defaultSettings.colorScheme;

  return {
    theme,
    colorScheme,
    customColors: {
      ...defaultSettings.customColors,
      ...(settings?.customColors ?? {}),
    },
    security: {
      ...defaultSettings.security,
      ...(settings?.security ?? {}),
    },
  };
}

function isTheme(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

function isColorScheme(value: unknown): value is ColorSchemeId {
  return value === "terminal" || value === "ember" || value === "glacier" || value === "custom";
}

function deriveKey(
  password: string,
  salt: Buffer,
  params: Pick<VaultFile["kdf"], "N" | "r" | "p">,
): Buffer {
  return scryptSync(password, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function normalizeStoredAccount(account: TotpAccount): TotpAccount {
  return {
    id: account.id || crypto.randomUUID(),
    issuer: account.issuer || "Unknown",
    label: account.label || "Account",
    secret: account.secret || "",
    algorithm: account.algorithm || "SHA1",
    digits: account.digits || 6,
    period: account.period || 30,
  };
}
