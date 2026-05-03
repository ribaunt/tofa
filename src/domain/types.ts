export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export type TotpAccount = {
  id: string;
  issuer: string;
  label: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
};

export type TotpCode = {
  code: string;
  remainingSeconds: number;
};

export type ThemeMode = "dark" | "light";

export type ColorSchemeId = "terminal" | "ember" | "glacier" | "custom";

export type AppSettings = {
  theme: ThemeMode;
  colorScheme: ColorSchemeId;
  customColors: {
    active: string;
    bg: string;
    border: string;
    panel: string;
    text: string;
  };
  security: {
    hideConfidentialValues: boolean;
    programmableApiEnabled: boolean;
  };
};

export type VaultData = {
  accounts: TotpAccount[];
  settings: AppSettings;
};

export type VaultFile = {
  version: 1;
  kdf: {
    name: "scrypt";
    salt: string;
    N: number;
    r: number;
    p: number;
  };
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    tag: string;
  };
  ciphertext: string;
};
