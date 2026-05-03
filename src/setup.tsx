import React, { useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { getDefaultVaultPath, initializeVault, vaultExists } from "./domain/vault";

type Step = "password" | "confirm" | "creating";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function runSetup(vaultPath: string): Promise<void> {
  if (await vaultExists(vaultPath)) return;

  const instance = render(React.createElement(SetupApp, { vaultPath }), {
    alternateScreen: true,
  });
  await instance.waitUntilExit();
}

function SetupApp(props: { vaultPath: string }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("Choose a master password.");
  const [cursorVisible, setCursorVisible] = useState(true);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const width = Math.max(columns, 48);
  const height = Math.max(rows, 18);
  const compact = width < 76 || height < 24;
  const cardWidth = Math.min(compact ? width - 4 : 68, width - 4);
  const label = step === "password" ? "Password" : "Confirm";
  const progress = step === "password" ? "1/2" : step === "confirm" ? "2/2" : "creating";

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((visible) => !visible), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (step !== "creating") return;

    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % spinnerFrames.length);
    }, 80);

    return () => clearInterval(timer);
  }, [step]);

  useInput((value, key) => {
    if (step === "creating") return;

    if (key.escape || (key.ctrl && value === "c")) {
      exit();
      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }

    if (value) {
      setInput((current) => current + value);
    }
  });

  async function submit() {
    if (step === "password") {
      if (input.length < 8) {
        setInput("");
        setMessage("Use at least 8 characters.");
        return;
      }

      setPassword(input);
      setInput("");
      setStep("confirm");
      setMessage("Confirm the master password.");
      return;
    }

    if (input !== password) {
      setPassword("");
      setInput("");
      setStep("password");
      setMessage("Passwords did not match. Choose a master password.");
      return;
    }

    setInput("");
    setStep("creating");
    setMessage("Creating your wallet...");
    await Promise.all([initializeVault(password, props.vaultPath), delay(900)]);
    setTimeout(() => exit(), 250);
  }

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor="#080d0c"
      paddingX={compact ? 1 : 2}
      paddingY={compact ? 0 : 1}
    >
      <Box justifyContent="space-between">
        <Text color="#d7f8a7" bold>TOFA</Text>
        {!compact && <Text color="#7f9189">First-run encrypted vault setup</Text>}
        <Text color="#d8e5dd">{progress}</Text>
      </Box>

      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Box
          width={cardWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor="#355045"
          backgroundColor="#101815"
          paddingX={compact ? 1 : 2}
          paddingY={compact ? 0 : 1}
          gap={compact ? 0 : 1}
        >
          <Text color="#d7f8a7" bold>{step === "creating" ? "CREATING WALLET" : "CREATE MASTER PASSWORD"}</Text>
          <Text color={message.includes("did not") || message.includes("at least") ? "#ff8a8a" : "#d8e5dd"}>
            {step === "creating" ? `${spinnerFrames[spinnerIndex]} ${message}` : message}
          </Text>
          {step !== "creating" && (
            <Box flexDirection="column">
              <Text color="#7f9189">{label}</Text>
              <PasswordInput value={input} cursorVisible={cursorVisible} />
            </Box>
          )}
          {!compact && (
            <Text color="#7f9189">
              The vault is encrypted locally. This password is never stored.
            </Text>
          )}
        </Box>
      </Box>

      <Box justifyContent="space-between">
        <Text color="#7f9189">Enter continue</Text>
        <Text color="#7f9189">Esc cancel</Text>
      </Box>
    </Box>
  );
}

function PasswordInput(props: { value: string; cursorVisible: boolean }) {
  return (
    <Text color="#d7f8a7" bold>
      {"*".repeat(props.value.length)}
      <Text color={props.cursorVisible ? "#101815" : "#d7f8a7"} backgroundColor={props.cursorVisible ? "#d7f8a7" : "#101815"}>
        {" "}
      </Text>
    </Text>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) {
  await runSetup(getDefaultVaultPath());
}
