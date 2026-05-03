import { createCliRenderer, TextAttributes, type PasteEvent } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/react";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { copyToClipboard } from "./domain/clipboard";
import { createAccount, normalizeAccountDraft, parseOtpAuthUri } from "./domain/otpauth";
import { generateTotp } from "./domain/totp";
import type { AppSettings, ColorSchemeId, TotpAccount, TotpAlgorithm } from "./domain/types";
import { defaultSettings, getDefaultVaultPath, loadVault, saveVault, vaultExists } from "./domain/vault";
import { runSetup } from "./setup";

type AppMode = "locked" | "dashboard" | "search" | "form" | "import" | "delete" | "settings";
type FormKind = "add" | "edit";

type AccountForm = {
  issuer: string;
  label: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: string;
  period: string;
};

type Palette = {
  active: string;
  bg: string;
  border: string;
  backdrop: string;
  danger: string;
  modal: string;
  muted: string;
  ok: string;
  panel: string;
  panelAlt: string;
  text: string;
  warn: string;
};

const colorSchemes: Record<Exclude<ColorSchemeId, "custom">, Pick<Palette, "active" | "bg" | "border" | "panel" | "text">> = {
  terminal: {
    active: "#d7f8a7",
    bg: "#080d0c",
    border: "#355045",
    panel: "#101815",
    text: "#d8e5dd",
  },
  ember: {
    active: "#ffcc66",
    bg: "#120c0a",
    border: "#7a4b32",
    panel: "#201410",
    text: "#f4dfcf",
  },
  glacier: {
    active: "#9de7ff",
    bg: "#071014",
    border: "#3d6673",
    panel: "#0f1b20",
    text: "#d8eef5",
  },
};
const colorSchemeOrder: ColorSchemeId[] = ["terminal", "ember", "glacier", "custom"];
let colors = createPalette(defaultSettings);

const clipboardCopiedMessage = "Copied to clipboard.";
const formFields: Array<keyof AccountForm> = ["issuer", "label", "secret", "algorithm", "digits", "period"];
const formFieldDescriptions: Record<keyof AccountForm, string> = {
  issuer: "Service name",
  label: "Email or username",
  secret: "Base32 seed",
  algorithm: "SHA1/SHA256/SHA512",
  digits: "Token length",
  period: "Refresh seconds",
};
const deleteHoldDurationMs = 3000;
const settingsRows = [
  "theme",
  "colorScheme",
  "customActive",
  "customBg",
  "customPanel",
  "customBorder",
  "customText",
  "hideConfidential",
  "programmableApi",
] as const;
type SettingsRow = typeof settingsRows[number];
const bigDigitFont: Record<string, string[]> = {
  "0": ["███", "█ █", "█ █", "█ █", "███"],
  "1": [" █ ", "██ ", " █ ", " █ ", "███"],
  "2": ["███", "  █", "███", "█  ", "███"],
  "3": ["███", "  █", " ██", "  █", "███"],
  "4": ["█ █", "█ █", "███", "  █", "  █"],
  "5": ["███", "█  ", "███", "  █", "███"],
  "6": ["███", "█  ", "███", "█ █", "███"],
  "7": ["███", "  █", "  █", "  █", "  █"],
  "8": ["███", "█ █", "███", "█ █", "███"],
  "9": ["███", "█ █", "███", "  █", "███"],
};
const vaultPath = getDefaultVaultPath();

if (!(await vaultExists(vaultPath))) {
  await runSetup(vaultPath);
}

if (!(await vaultExists(vaultPath))) {
  process.exit(0);
}

function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [mode, setMode] = useState<AppMode>("locked");
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [accounts, setAccounts] = useState<TotpAccount[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [confidentialVisible, setConfidentialVisible] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [formKind, setFormKind] = useState<FormKind>("add");
  const [form, setForm] = useState<AccountForm>(emptyForm());
  const [formIndex, setFormIndex] = useState(0);
  const [importValue, setImportValue] = useState("");
  const [message, setMessage] = useState("Unlock your vault.");
  const [tick, setTick] = useState(() => Date.now());
  const [cursorVisible, setCursorVisible] = useState(true);
  const [deleteHoldStartedAt, setDeleteHoldStartedAt] = useState<number | null>(null);
  const [deleteHoldLastSeenAt, setDeleteHoldLastSeenAt] = useState<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((visible) => !visible), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (message !== clipboardCopiedMessage) return;

    const timer = setTimeout(() => {
      setMessage((current) => current === clipboardCopiedMessage ? "" : current);
    }, 3000);

    return () => clearTimeout(timer);
  }, [message]);

  useBindings(
    () => ({
      commands: [
        {
          name: "quit",
          run() {
            quitApp();
          },
        },
      ],
      bindings: [{ key: "ctrl+c", cmd: "quit" }],
    }),
    [renderer],
  );

  const filteredAccounts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return accounts;

    return accounts.filter((account) =>
      `${account.issuer} ${account.label}`.toLowerCase().includes(query),
    );
  }, [accounts, search]);

  const selectedAccount = filteredAccounts[selectedIndex] ?? null;
  colors = createPalette(settings);
  const isNarrow = width < 92;
  const isShort = height < 26;
  const isCompact = isNarrow || isShort;
  const accountRowLimit = isNarrow ? (isShort ? 4 : 6) : isShort ? 7 : Math.max(8, height - 13);
  const popupWidth = clamp(Math.floor(width * (isNarrow ? 0.92 : 0.56)), 34, Math.max(34, width - 6));
  const showConfidential = !settings.security.hideConfidentialValues || confidentialVisible;

  useEffect(() => {
    setSelectedIndex((current) => clamp(current, 0, Math.max(filteredAccounts.length - 1, 0)));
  }, [filteredAccounts.length]);

  useEffect(() => {
    if (mode !== "delete" || !selectedAccount || deleteHoldStartedAt === null || deleteHoldLastSeenAt === null) return;
    if (tick - deleteHoldLastSeenAt > 500) {
      setDeleteHoldStartedAt(null);
      setDeleteHoldLastSeenAt(null);
      return;
    }

    if (tick - deleteHoldStartedAt < deleteHoldDurationMs) return;

    const accountId = selectedAccount.id;
    const nextAccounts = accounts.filter((account) => account.id !== accountId);

    setDeleteHoldStartedAt(null);
    setDeleteHoldLastSeenAt(null);
    void saveAndSet(nextAccounts).then(() => {
      setMode("dashboard");
      setMessage("");
    });
  }, [accounts, deleteHoldLastSeenAt, deleteHoldStartedAt, mode, selectedAccount, tick]);

  useKeyboard((key) => {
    if (key.eventType === "release") {
      if (mode === "delete" && key.name === "y") {
        setDeleteHoldStartedAt(null);
        setDeleteHoldLastSeenAt(null);
      }

      return;
    }

    if (mode === "locked") {
      handlePasswordKey(key);
      return;
    }

    if (mode === "dashboard") {
      handleDashboardKey(key);
      return;
    }

    if (mode === "search") {
      handleSearchKey(key);
      return;
    }

    if (mode === "form") {
      handleFormKey(key);
      return;
    }

    if (mode === "import") {
      handleImportKey(key);
      return;
    }

    if (mode === "settings") {
      handleSettingsKey(key);
      return;
    }

    handleDeleteKey(key);
  }, { release: true });

  useEffect(() => {
    const handlePaste = (event: PasteEvent) => {
      const text = pastedText(event);
      if (!text) return;

      event.preventDefault();
      event.stopPropagation();
      pasteIntoActiveField(text);
    };

    renderer.keyInput.on("paste", handlePaste);

    return () => {
      renderer.keyInput.off("paste", handlePaste);
    };
  }, [mode, formIndex, renderer]);

  function pasteIntoActiveField(text: string) {
    if (mode === "locked") {
      setPasswordInput((value) => value + text);
      setMessage("Pasted into password field.");
      return;
    }

    if (mode === "search") {
      setSearch((value) => value + text);
      setMessage("");
      return;
    }

    if (mode === "form") {
      editFormField((value) => value + text);
      setMessage("");
      return;
    }

    if (mode === "import") {
      setImportValue((value) => value + text);
      setMessage("");
      return;
    }

    if (mode === "settings" && isCustomColorRow(settingsRows[settingsIndex])) {
      void updateCustomColor((value) => value + text);
      setMessage("");
    }
  }

  function handlePasswordKey(key: KeyboardKey) {
    if (isQuit(key)) {
      quitApp();
      return;
    }

    if (isEnter(key)) {
      void unlockVault();
      return;
    }

    if (isBackspace(key)) {
      setPasswordInput((value) => value.slice(0, -1));
      return;
    }

    const text = keyText(key);
    if (text) setPasswordInput((value) => value + text);
  }

  async function unlockVault() {
    try {
      const data = await loadVault(passwordInput, vaultPath);
      setPassword(passwordInput);
      setAccounts(data.accounts);
      setSettings(data.settings);
      setConfidentialVisible(!data.settings.security.hideConfidentialValues);
      setPasswordInput("");
      setMode("dashboard");
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
      setPasswordInput("");
    }
  }

  function handleDashboardKey(key: KeyboardKey) {
    if (isQuit(key) || key.name === "q") {
      quitApp();
      return;
    }

    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((index) => clamp(index - 1, 0, Math.max(filteredAccounts.length - 1, 0)));
      return;
    }

    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((index) => clamp(index + 1, 0, Math.max(filteredAccounts.length - 1, 0)));
      return;
    }

    if (key.name === "/") {
      setMode("search");
      setMessage("");
      return;
    }

    if (key.name === "a") {
      openForm("add");
      return;
    }

    if (key.name === "e" && selectedAccount) {
      openForm("edit", selectedAccount);
      return;
    }

    if (key.name === "d" && selectedAccount) {
      setDeleteHoldStartedAt(null);
      setDeleteHoldLastSeenAt(null);
      setMode("delete");
      setMessage("");
      return;
    }

    if (key.name === "i") {
      setImportValue("");
      setMode("import");
      setMessage("");
      return;
    }

    if (key.name === "s") {
      setSettingsIndex(0);
      setMode("settings");
      setMessage("");
      return;
    }

    if (key.name === "h") {
      setConfidentialVisible((visible) => !visible);
      setMessage("");
      return;
    }

    if (isEnter(key) && selectedAccount) {
      const { code } = generateTotp(selectedAccount, tick);
      try {
        copyToClipboard(code);
        setMessage(clipboardCopiedMessage);
      } catch (error) {
        setMessage(errorMessage(error));
      }
    }
  }

  function handleSearchKey(key: KeyboardKey) {
    if (isEscape(key)) {
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (isEnter(key)) {
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (isBackspace(key)) {
      setSearch((value) => value.slice(0, -1));
      setMessage("");
      return;
    }

    const text = keyText(key);
    if (text) {
      setSearch((value) => value + text);
      setMessage("");
    }
  }

  function openForm(kind: FormKind, account?: TotpAccount) {
    setFormKind(kind);
    setForm(account ? formFromAccount(account) : emptyForm());
    setFormIndex(0);
    setMode("form");
    setMessage("");
  }

  function handleFormKey(key: KeyboardKey) {
    if (isEscape(key)) {
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (key.name === "tab" || key.name === "down") {
      setFormIndex((index) => (index + 1) % formFields.length);
      setMessage("");
      return;
    }

    if (key.name === "up") {
      setFormIndex((index) => (index - 1 + formFields.length) % formFields.length);
      setMessage("");
      return;
    }

    if (isEnter(key)) {
      if (formIndex === formFields.length - 1) {
        void submitForm();
      } else {
        setFormIndex((index) => index + 1);
      }
      return;
    }

    if (isBackspace(key)) {
      editFormField((value) => value.slice(0, -1));
      return;
    }

    const text = keyText(key);
    if (text) editFormField((value) => value + text);
  }

  function editFormField(update: (value: string) => string) {
    const field = formFields[formIndex];
    if (!field) return;

    setMessage("");
    setForm((current) => ({
      ...current,
      [field]: field === "algorithm" ? update(String(current[field])).toUpperCase() : update(String(current[field])),
    }));
  }

  async function submitForm() {
    try {
      const draft = normalizeAccountDraft({
        issuer: form.issuer,
        label: form.label,
        secret: form.secret,
        algorithm: form.algorithm,
        digits: Number.parseInt(form.digits, 10),
        period: Number.parseInt(form.period, 10),
      });

      const nextAccounts =
        formKind === "add"
          ? [...accounts, createAccount(draft)]
          : accounts.map((account) =>
              account.id === selectedAccount?.id
                ? {
                    ...account,
                    ...draft,
                  }
                : account,
            );

      await saveAndSet(nextAccounts);
      setMode("dashboard");
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function handleImportKey(key: KeyboardKey) {
    if (isEscape(key)) {
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (isEnter(key)) {
      void submitImport();
      return;
    }

    if (isBackspace(key)) {
      setImportValue((value) => value.slice(0, -1));
      setMessage("");
      return;
    }

    const text = keyText(key);
    if (text) {
      setImportValue((value) => value + text);
      setMessage("");
    }
  }

  async function submitImport() {
    try {
      const account = parseOtpAuthUri(importValue);
      await saveAndSet([...accounts, account]);
      setImportValue("");
      setMode("dashboard");
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function handleSettingsKey(key: KeyboardKey) {
    const row = settingsRows[settingsIndex];

    if (isEscape(key)) {
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (key.name === "up" || key.name === "k") {
      setSettingsIndex((index) => (index - 1 + settingsRows.length) % settingsRows.length);
      setMessage("");
      return;
    }

    if (key.name === "down" || key.name === "j" || key.name === "tab") {
      setSettingsIndex((index) => (index + 1) % settingsRows.length);
      setMessage("");
      return;
    }

    if ((key.name === "left" || key.name === "right" || isEnter(key)) && row) {
      void activateSettingsRow(row, key.name === "left" ? -1 : 1);
      return;
    }

    if (isBackspace(key) && isCustomColorRow(row)) {
      void updateCustomColor((value) => value.slice(0, -1));
      return;
    }

    const text = keyText(key);
    if (text && isCustomColorRow(row)) {
      void updateCustomColor((value) => value + text);
    }
  }

  async function activateSettingsRow(row: SettingsRow, direction: 1 | -1) {
    if (row === "theme") {
      await saveSettings({
        ...settings,
        theme: settings.theme === "dark" ? "light" : "dark",
      });
      return;
    }

    if (row === "colorScheme") {
      const index = colorSchemeOrder.indexOf(settings.colorScheme);
      const nextIndex = (index + direction + colorSchemeOrder.length) % colorSchemeOrder.length;
      const colorScheme = colorSchemeOrder[nextIndex] ?? "terminal";

      await saveSettings({ ...settings, colorScheme });
      return;
    }

    if (row === "hideConfidential") {
      const hideConfidentialValues = !settings.security.hideConfidentialValues;

      setConfidentialVisible(!hideConfidentialValues);
      await saveSettings({
        ...settings,
        security: { ...settings.security, hideConfidentialValues },
      });
      return;
    }

    if (row === "programmableApi") {
      await saveSettings({
        ...settings,
        security: {
          ...settings.security,
          programmableApiEnabled: !settings.security.programmableApiEnabled,
        },
      });
    }
  }

  async function updateCustomColor(update: (value: string) => string) {
    const row = settingsRows[settingsIndex];
    const colorKey = customColorKey(row);
    if (!colorKey) return;

    const nextValue = update(settings.customColors[colorKey]);

    await saveSettings({
      ...settings,
      colorScheme: "custom",
      customColors: {
        ...settings.customColors,
        [colorKey]: nextValue,
      },
    });
  }

  function handleDeleteKey(key: KeyboardKey) {
    if (isEscape(key) || key.name === "n") {
      setDeleteHoldStartedAt(null);
      setDeleteHoldLastSeenAt(null);
      setMode("dashboard");
      setMessage("");
      return;
    }

    if (key.name === "y" && selectedAccount) {
      const now = Date.now();

      setDeleteHoldStartedAt((startedAt) => startedAt ?? now);
      setDeleteHoldLastSeenAt(now);
    }
  }

  async function saveAndSet(nextAccounts: TotpAccount[], nextSettings = settings) {
    await saveVault(password, nextAccounts, nextSettings, vaultPath);
    setAccounts(nextAccounts);
  }

  async function saveSettings(nextSettings: AppSettings) {
    await saveVault(password, accounts, nextSettings, vaultPath);
    setSettings(nextSettings);
    setMessage("");
  }

  function quitApp() {
    renderer.destroy();
    process.exit(0);
  }

  if (mode === "locked") {
    return <LockedView password={passwordInput} message={message} cursorVisible={cursorVisible} />;
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={isCompact ? 0 : 1} gap={isCompact ? 0 : 1}>
      <Header accountCount={accounts.length} compact={isCompact} vaultPath={vaultPath} />
      <box flexDirection={isNarrow ? "column" : "row"} flexGrow={1} gap={isCompact ? 0 : 1}>
        <AccountList
          accounts={filteredAccounts}
          compact={isCompact}
          maxRows={accountRowLimit}
          narrow={isNarrow}
          selectedIndex={selectedIndex}
          search={search}
          showConfidential={showConfidential}
          now={tick}
        />
        <DetailPanel account={selectedAccount} compact={isCompact} now={tick} mode={mode} short={isShort} showConfidential={showConfidential} />
      </box>
      {mode === "search" && (
        <PopupLayer width={popupWidth}>
          <SearchPanel value={search} cursorVisible={cursorVisible} />
        </PopupLayer>
      )}
      {mode === "form" && (
        <PopupLayer width={popupWidth}>
          <FormPanel form={form} formIndex={formIndex} kind={formKind} cursorVisible={cursorVisible} showConfidential={showConfidential} />
        </PopupLayer>
      )}
      {mode === "import" && (
        <PopupLayer width={popupWidth}>
          <ImportPanel value={importValue} cursorVisible={cursorVisible} />
        </PopupLayer>
      )}
      {mode === "settings" && (
        <PopupLayer width={popupWidth}>
          <SettingsPanel cursorVisible={cursorVisible} settings={settings} selectedIndex={settingsIndex} />
        </PopupLayer>
      )}
      {mode === "delete" && (
        <PopupLayer width={popupWidth}>
          <DeletePanel
            account={selectedAccount}
            holdProgress={deleteHoldStartedAt === null ? 0 : clamp((tick - deleteHoldStartedAt) / deleteHoldDurationMs, 0, 1)}
            isHolding={deleteHoldStartedAt !== null}
          />
        </PopupLayer>
      )}
      <StatusBar
        account={selectedAccount}
        deleteHoldStartedAt={deleteHoldStartedAt}
        deleteHoldLastSeenAt={deleteHoldLastSeenAt}
        formIndex={formIndex}
        formKind={formKind}
        importValue={importValue}
        message={message}
        mode={mode}
        compact={isCompact}
        search={search}
        settingsIndex={settingsIndex}
      />
    </box>
  );
}

function LockedView(props: { password: string; message: string; cursorVisible: boolean }) {
  return (
    <box alignItems="center" justifyContent="center" flexGrow={1} backgroundColor={colors.bg}>
      <box
        flexDirection="column"
        width={56}
        borderStyle="rounded"
        borderColor={colors.border}
        padding={2}
        gap={1}
      >
        <ascii-font font="tiny" text="TOFA" />
        <text fg={colors.muted}>An encrypted local TOTP vault</text>
        <box flexDirection="row" gap={1}>
          <text fg={colors.active}>Password</text>
          <text fg={colors.text}>
            <EditableText value={props.password} masked cursorVisible={props.cursorVisible} bg={colors.bg} />
          </text>
        </box>
        <text fg={props.message.includes("Could not") ? colors.danger : colors.muted}>{props.message}</text>
      </box>
    </box>
  );
}

function Header(props: { accountCount: number; compact: boolean; vaultPath: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row" gap={1}>
        <text fg={colors.active} attributes={TextAttributes.BOLD}>TOFA</text>
        {!props.compact && <text fg={colors.muted}>TOTP vault</text>}
        <text fg={colors.text}>{props.accountCount} accounts</text>
      </box>
      {!props.compact && <text fg={colors.muted} truncate>{props.vaultPath}</text>}
    </box>
  );
}

function AccountList(props: {
  accounts: TotpAccount[];
  compact: boolean;
  maxRows: number;
  narrow: boolean;
  selectedIndex: number;
  search: string;
  showConfidential: boolean;
  now: number;
}) {
  const rows = props.accounts.length > 0 ? props.accounts : [];

  return (
    <box
      flexDirection="column"
      width={props.narrow ? "100%" : "44%"}
      height={props.narrow ? (props.compact ? 7 : 10) : "auto"}
      borderStyle="rounded"
      borderColor={colors.border}
      backgroundColor={colors.panel}
      padding={props.compact ? 0 : 1}
      title="ACCOUNTS"
      gap={props.compact ? 0 : 1}
    >
      {!props.compact && props.search && <text fg={colors.muted}>Filter {props.search}</text>}
      {rows.length === 0 ? (
        <text fg={colors.warn}>No accounts match.</text>
      ) : (
        rows.slice(0, props.maxRows).map((account, index) => {
          const selected = index === props.selectedIndex;
          const { code, remainingSeconds } = generateTotp(account, props.now);
          const displayCode = props.showConfidential ? code : maskCode(code);

          return (
            <box key={account.id} flexDirection="column" backgroundColor={selected ? colors.panelAlt : colors.panel}>
              <text fg={selected ? colors.active : colors.text} attributes={selected ? TextAttributes.BOLD : 0}>
                {props.compact
                  ? `${selected ? ">" : " "} ${fit(account.issuer, 12)} ${fit(account.label, 16)} ${displayCode} ${remainingSeconds}s`
                  : `${selected ? ">" : " "} ${fit(account.issuer, 16)} ${fit(account.label, 22)}`}
              </text>
              {!props.compact && (
                <text fg={selected ? colors.ok : colors.muted}>
                  {`  ${displayCode}  ${remainingSeconds.toString().padStart(2, "0")}s`}
                </text>
              )}
            </box>
          );
        })
      )}
    </box>
  );
}

function DetailPanel(props: { account: TotpAccount | null; compact: boolean; now: number; mode: AppMode; short: boolean; showConfidential: boolean }) {
  if (!props.account) {
    return (
      <box flexDirection="column" flexGrow={1} borderStyle="rounded" borderColor={colors.border} padding={1}>
        <text fg={colors.warn}>No account selected.</text>
      </box>
    );
  }

  const { code, remainingSeconds } = generateTotp(props.account, props.now);
  const displayCode = props.showConfidential ? code : maskCode(code);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      borderStyle="rounded"
      borderColor={colors.border}
      backgroundColor={colors.panel}
      padding={props.compact ? 0 : 2}
      gap={props.compact ? 0 : 1}
      title="CODE"
    >
      <text fg={colors.muted}>{props.account.issuer}</text>
      <text fg={colors.text} attributes={TextAttributes.BOLD}>{props.account.label}</text>
      <BigCode code={displayCode} compact={props.compact || props.short} />
      <text fg={remainingSeconds <= 5 ? colors.warn : colors.ok}>
        {`${remainingSeconds}s remaining`}
      </text>
      {!props.short && (
        <text fg={colors.muted}>
          {`${props.account.algorithm} / ${props.account.digits} digits / ${props.account.period}s`}
        </text>
      )}
    </box>
  );
}

function BigCode(props: { code: string; compact: boolean }) {
  if (props.compact || /\D/.test(props.code)) {
    return (
      <text fg={colors.active} attributes={TextAttributes.BOLD}>
        {formatCompactCode(props.code)}
      </text>
    );
  }

  return (
    <box flexDirection="column" gap={0} marginY={1}>
      {buildBigCodeRows(props.code).map((row, index) => (
        <text key={`${index}-${row}`} fg={colors.active} attributes={TextAttributes.BOLD}>
          {row}
        </text>
      ))}
    </box>
  );
}

function PopupLayer(props: { children: ReactNode; width: number }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      alignItems="center"
      justifyContent="center"
    >
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={0}
        backgroundColor={colors.backdrop}
        opacity={0.78}
      />
      <box flexDirection="column" width={props.width} zIndex={1}>
        {props.children}
      </box>
    </box>
  );
}

function SearchPanel(props: { value: string; cursorVisible: boolean }) {
  return (
    <box borderStyle="rounded" borderColor={colors.active} backgroundColor={colors.modal} paddingX={1}>
      <text fg={colors.active}>/ <EditableText value={props.value} cursorVisible={props.cursorVisible} fg={colors.active} /></text>
    </box>
  );
}

function buildBigCodeRows(code: string): string[] {
  const rows = Array.from({ length: 5 }, () => "");

  for (const char of code) {
    const glyph = bigDigitFont[char] ?? ["   ", "   ", "   ", "   ", "   "];

    for (let row = 0; row < rows.length; row += 1) {
      rows[row] += `${glyph[row]}  `;
    }
  }

  return rows.map((row) => row.trimEnd());
}

function formatCompactCode(code: string): string {
  if (code.length <= 4) return code;

  const middle = Math.ceil(code.length / 2);
  return `${code.slice(0, middle)} ${code.slice(middle)}`;
}

function FormPanel(props: { form: AccountForm; formIndex: number; kind: FormKind; cursorVisible: boolean; showConfidential: boolean }) {
  return (
    <box flexDirection="column" borderStyle="rounded" borderColor={colors.active} backgroundColor={colors.modal} padding={1} gap={1}>
      <text fg={colors.active}>{props.kind === "add" ? "ADD ACCOUNT" : "EDIT ACCOUNT"}</text>
      {formFields.map((field, index) => {
        const selected = index === props.formIndex;

        return (
          <text key={field} fg={selected ? colors.active : colors.text}>
            {`${selected ? ">" : " "} ${field.padEnd(9)} `}
            {selected ? (
              <EditableText
                value={String(props.form[field])}
                cursorVisible={props.cursorVisible}
                fg={colors.active}
                masked={field === "secret" && !props.showConfidential}
              />
            ) : (
              field === "secret" && !props.showConfidential ? maskSecret(props.form[field]) : String(props.form[field])
            )}
          </text>
        );
      })}
    </box>
  );
}

function ImportPanel(props: { value: string; cursorVisible: boolean }) {
  return (
    <box flexDirection="column" borderStyle="rounded" borderColor={colors.active} backgroundColor={colors.modal} padding={1} gap={1}>
      <text fg={colors.active}>IMPORT OTPAUTH URI</text>
      <text fg={colors.text} wrapMode="char">
        <EditableText value={props.value} cursorVisible={props.cursorVisible} />
      </text>
    </box>
  );
}

function SettingsPanel(props: { cursorVisible: boolean; settings: AppSettings; selectedIndex: number }) {
  return (
    <box flexDirection="column" borderStyle="rounded" borderColor={colors.active} backgroundColor={colors.modal} padding={1} gap={1}>
      <text fg={colors.active}>SETTINGS</text>
      {settingsRows.map((row, index) => {
        const selected = index === props.selectedIndex;

        return (
          <text key={row} fg={selected ? colors.active : colors.text}>
            {`${selected ? ">" : " "} ${settingsRowLabel(row).padEnd(24)} `}
            {selected && isCustomColorRow(row) ? (
              <EditableText
                value={settingsRowValue(row, props.settings)}
                cursorVisible={props.cursorVisible}
                fg={colors.active}
              />
            ) : (
              settingsRowValue(row, props.settings)
            )}
          </text>
        );
      })}
    </box>
  );
}

function EditableText(props: { value: string; cursorVisible: boolean; masked?: boolean; fg?: string; bg?: string }) {
  const value = props.masked ? "*".repeat(props.value.length) : props.value;
  const background = props.bg ?? colors.modal;

  return (
    <>
      {value}
      <span
        fg={props.cursorVisible ? background : props.fg ?? colors.text}
        bg={props.cursorVisible ? colors.active : background}
      >
        {" "}
      </span>
    </>
  );
}

function DeletePanel(props: { account: TotpAccount | null; holdProgress: number; isHolding: boolean }) {
  const progress = Math.round(props.holdProgress * 20);

  return (
    <box flexDirection="column" borderStyle="rounded" borderColor={colors.danger} backgroundColor={colors.modal} paddingX={1}>
      <text fg={colors.danger}>
        {props.account ? `Delete ${props.account.issuer} / ${props.account.label}: hold y 3s, n abort` : "No account."}
      </text>
      <text fg={props.isHolding ? colors.warn : colors.muted}>
        {`[${"█".repeat(progress)}${" ".repeat(20 - progress)}] ${Math.floor(props.holdProgress * 100)}%`}
      </text>
    </box>
  );
}

function StatusBar(props: {
  account: TotpAccount | null;
  compact: boolean;
  deleteHoldLastSeenAt: number | null;
  deleteHoldStartedAt: number | null;
  formIndex: number;
  formKind: FormKind;
  importValue: string;
  message: string;
  mode: AppMode;
  search: string;
  settingsIndex: number;
}) {
  const hints =
    props.mode === "dashboard"
      ? props.compact
        ? "↵ copy  /  a e d i s  h  q"
        : "j/k move  ↵ copy  / filter  a add  e edit  d del  i import  s set  h show  q"
      : props.mode === "delete"
        ? "hold y delete  n/esc abort"
      : props.mode === "settings"
        ? "j/k move  ↵ toggle  type colors  esc"
      : "↵ confirm  esc";
  const hasProblem = isProblemMessage(props.message);
  const statusText = props.message || selectedPartDescription(props);

  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={hasProblem ? colors.danger : colors.muted} truncate>{statusText}</text>
      <text fg={colors.muted}>{hints}</text>
    </box>
  );
}

function selectedPartDescription(props: {
  account: TotpAccount | null;
  deleteHoldLastSeenAt: number | null;
  deleteHoldStartedAt: number | null;
  formIndex: number;
  formKind: FormKind;
  importValue: string;
  mode: AppMode;
  search: string;
  settingsIndex: number;
}): string {
  if (props.mode === "dashboard") {
    if (!props.account) return "No account. a add / i import";
    return "";
  }

  if (props.mode === "search") {
    return props.search
      ? `Filter: ${props.search}`
      : "Filter issuer/label";
  }

  if (props.mode === "form") {
    const field = formFields[props.formIndex];
    const action = props.formKind === "add" ? "Add account" : "Edit account";

    return field ? `${action}: ${formFieldDescriptions[field]}` : `${action}: choose field`;
  }

  if (props.mode === "import") {
    return props.importValue
      ? "URI ready"
      : "Paste otpauth URI";
  }

  if (props.mode === "delete") {
    if (!props.account) return "No account";
    if (props.deleteHoldStartedAt !== null && props.deleteHoldLastSeenAt !== null) {
      return "Keep holding y";
    }

    return "Hold y 3s to delete";
  }

  if (props.mode === "settings") {
    const row = settingsRows[props.settingsIndex];
    return row ? settingsRowDescription(row) : "Settings";
  }

  return "Unlock vault";
}

function createPalette(settings: AppSettings): Palette {
  const base =
    settings.colorScheme === "custom"
      ? settings.customColors
      : colorSchemes[settings.colorScheme] ?? colorSchemes.terminal;
  const sanitizedBase = {
    active: validHexColor(base.active, defaultSettings.customColors.active),
    bg: validHexColor(base.bg, defaultSettings.customColors.bg),
    border: validHexColor(base.border, defaultSettings.customColors.border),
    panel: validHexColor(base.panel, defaultSettings.customColors.panel),
    text: validHexColor(base.text, defaultSettings.customColors.text),
  };

  if (settings.colorScheme === "custom") {
    const lightMode = settings.theme === "light";
    const panel = sanitizedBase.panel;
    const text = lightMode ? readableOnLight(sanitizedBase.text, "#0d1511") : sanitizedBase.text;

    return {
      active: lightMode ? readableOnLight(sanitizedBase.active, "#2f6624") : sanitizedBase.active,
      bg: sanitizedBase.bg,
      border: lightMode ? readableOnLight(sanitizedBase.border, "#6a786f") : sanitizedBase.border,
      backdrop: "#141815",
      danger: lightMode ? "#821026" : "#ff8a8a",
      modal: panel,
      muted: lightMode ? "#3d4a43" : "#7f9189",
      ok: lightMode ? "#075f46" : "#8df0c2",
      panel,
      panelAlt: shadeColor(panel, lightMode ? -12 : 18),
      text,
      warn: lightMode ? "#744900" : "#f5cf7a",
    };
  }

  if (settings.theme === "light") {
    return {
      active: lightAccent(settings.colorScheme, sanitizedBase.active),
      bg: "#f5f7f2",
      border: lightBorder(settings.colorScheme),
      backdrop: "#d5ddd2",
      danger: "#821026",
      modal: "#ffffff",
      muted: "#3d4a43",
      ok: "#075f46",
      panel: "#edf2ea",
      panelAlt: "#dfe8dc",
      text: "#0d1511",
      warn: "#744900",
    };
  }

  return {
    active: sanitizedBase.active,
    bg: sanitizedBase.bg,
    border: sanitizedBase.border,
    backdrop: "#030605",
    danger: "#ff8a8a",
    modal: sanitizedBase.panel,
    muted: "#7f9189",
    ok: "#8df0c2",
    panel: sanitizedBase.panel,
    panelAlt: shadeColor(sanitizedBase.panel, 18),
    text: sanitizedBase.text,
    warn: "#f5cf7a",
  };
}

function settingsRowLabel(row: SettingsRow): string {
  switch (row) {
    case "theme":
      return "Theme";
    case "colorScheme":
      return "Color schema";
    case "customActive":
      return "Custom active";
    case "customBg":
      return "Custom background";
    case "customPanel":
      return "Custom panel";
    case "customBorder":
      return "Custom border";
    case "customText":
      return "Custom text";
    case "hideConfidential":
      return "Hide confidential";
    case "programmableApi":
      return "Programmable API";
  }
}

function settingsRowValue(row: SettingsRow, settings: AppSettings): string {
  switch (row) {
    case "theme":
      return settings.theme;
    case "colorScheme":
      return settings.colorScheme;
    case "customActive":
      return settings.customColors.active;
    case "customBg":
      return settings.customColors.bg;
    case "customPanel":
      return settings.customColors.panel;
    case "customBorder":
      return settings.customColors.border;
    case "customText":
      return settings.customColors.text;
    case "hideConfidential":
      return settings.security.hideConfidentialValues ? "enabled" : "disabled";
    case "programmableApi":
      return settings.security.programmableApiEnabled ? "enabled" : "disabled";
  }
}

function settingsRowDescription(row: SettingsRow): string {
  switch (row) {
    case "theme":
      return "Dark/light";
    case "colorScheme":
      return "Preset/custom colors";
    case "customActive":
    case "customBg":
    case "customPanel":
    case "customBorder":
    case "customText":
      return "Type hex color";
    case "hideConfidential":
      return "Mask codes/secrets";
    case "programmableApi":
      return "Programmable API";
  }
}

function isCustomColorRow(row: SettingsRow | undefined): boolean {
  return customColorKey(row) !== null;
}

function customColorKey(row: SettingsRow | undefined): keyof AppSettings["customColors"] | null {
  switch (row) {
    case "customActive":
      return "active";
    case "customBg":
      return "bg";
    case "customPanel":
      return "panel";
    case "customBorder":
      return "border";
    case "customText":
      return "text";
    default:
      return null;
  }
}

function maskCode(code: string): string {
  return "•".repeat(code.length);
}

function maskSecret(secret: string): string {
  return secret ? "•".repeat(Math.min(secret.length, 12)) : "";
}

function shadeColor(color: string, amount: number): string {
  const hex = color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color;

  const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) =>
    clamp(Number.parseInt(part, 16) + amount, 0, 255),
  );

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function lightAccent(scheme: ColorSchemeId, fallback: string): string {
  switch (scheme) {
    case "ember":
      return "#7a4a00";
    case "glacier":
      return "#075f73";
    case "terminal":
      return "#2f6624";
    case "custom":
      return readableOnLight(fallback, "#2f6624");
  }
}

function lightBorder(scheme: ColorSchemeId): string {
  switch (scheme) {
    case "ember":
      return "#8a6a54";
    case "glacier":
      return "#5d7881";
    case "terminal":
    case "custom":
      return "#6a786f";
  }
}

function readableOnLight(color: string, fallback: string): string {
  const normalized = validHexColor(color, fallback);
  return colorLuminance(normalized) > 0.42 ? shadeColor(normalized, -120) : normalized;
}

function colorLuminance(color: string): number {
  const hex = color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 0;

  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((part) => {
    const channel = Number.parseInt(part, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function validHexColor(color: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function emptyForm(): AccountForm {
  return {
    issuer: "",
    label: "",
    secret: "",
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  };
}

function formFromAccount(account: TotpAccount): AccountForm {
  return {
    issuer: account.issuer,
    label: account.label,
    secret: account.secret,
    algorithm: account.algorithm,
    digits: String(account.digits),
    period: String(account.period),
  };
}

function fit(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return value.slice(0, Math.max(width - 1, 0)) + ".";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type KeyboardKey = Parameters<Parameters<typeof useKeyboard>[0]>[0];

function isEnter(key: KeyboardKey): boolean {
  return key.name === "return" || key.name === "enter";
}

function isBackspace(key: KeyboardKey): boolean {
  return key.name === "backspace" || key.name === "delete";
}

function isEscape(key: KeyboardKey): boolean {
  return key.name === "escape";
}

function isQuit(key: KeyboardKey): boolean {
  return key.ctrl && key.name === "c";
}

function keyText(key: KeyboardKey): string | null {
  if (key.ctrl || key.meta) return null;
  if (key.name === "space") return " ";
  if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") return key.sequence;
  if (key.name.length === 1) return key.name;
  return null;
}

function pastedText(event: PasteEvent): string {
  return Buffer.from(event.bytes).toString("utf8").replace(/\r?\n/g, "");
}

function isProblemMessage(message: string): boolean {
  if (!message) return false;

  return [
    "algorithm",
    "could not",
    "digits",
    "invalid",
    "issuer",
    "label",
    "no supported",
    "only",
    "period",
    "secret",
    "unexpected",
  ].some((term) => message.toLowerCase().includes(term));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

const renderer = await createCliRenderer();
const keymap = createDefaultOpenTuiKeymap(renderer as never);

createRoot(renderer).render(
  <KeymapProvider keymap={keymap}>
    <App />
  </KeymapProvider>,
);
