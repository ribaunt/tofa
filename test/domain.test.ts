import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAccount, parseOtpAuthUri } from "../src/domain/otpauth";
import { generateTotp } from "../src/domain/totp";
import type { TotpAccount } from "../src/domain/types";
import { defaultSettings, loadVault, saveVault } from "../src/domain/vault";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("generates RFC 6238 SHA1 TOTP vector", () => {
  const account: TotpAccount = {
    id: "vector",
    issuer: "RFC",
    label: "SHA1",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1",
    digits: 8,
    period: 30,
  };

  expect(generateTotp(account, 59_000).code).toBe("94287082");
});

test("parses otpauth URI defaults and issuer", () => {
  const account = parseOtpAuthUri("otpauth://totp/Ribaunt:musti?secret=JBSWY3DPEHPK3PXP&issuer=Ribaunt");

  expect(account.issuer).toBe("Ribaunt");
  expect(account.label).toBe("musti");
  expect(account.algorithm).toBe("SHA1");
  expect(account.digits).toBe(6);
  expect(account.period).toBe(30);
});

test("round-trips encrypted vault and rejects wrong password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tofa-"));
  tempDirs.push(dir);

  const path = join(dir, "vault.json");
  const account = createAccount({
    issuer: "Example",
    label: "user@example.com",
    secret: "JBSWY3DPEHPK3PXP",
  });

  await saveVault("correct horse battery staple", [account], path);
  await expect(loadVault("wrong password", path)).rejects.toThrow("Could not unlock vault");

  const loaded = await loadVault("correct horse battery staple", path);
  expect(loaded.accounts).toEqual([account]);
});

test("persists vault settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tofa-"));
  tempDirs.push(dir);

  const path = join(dir, "vault.json");
  const settings = {
    ...defaultSettings,
    colorScheme: "custom" as const,
    customColors: {
      ...defaultSettings.customColors,
      active: "#abcdef",
    },
    security: {
      hideConfidentialValues: false,
      programmableApiEnabled: true,
    },
  };

  await saveVault("settings password", [], settings, path);

  const loaded = await loadVault("settings password", path);
  expect(loaded.settings).toEqual(settings);
});
