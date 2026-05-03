import { spawnSync } from "node:child_process";

type ClipboardCommand = {
  command: string;
  args: string[];
};

export function copyToClipboard(value: string): void {
  const commands = getClipboardCommands();

  for (const candidate of commands) {
    const result = spawnSync(candidate.command, candidate.args, {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (result.status === 0) return;
  }

  throw new Error("No supported clipboard command was found.");
}

function getClipboardCommands(): ClipboardCommand[] {
  if (process.platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (process.platform === "win32") return [{ command: "clip.exe", args: [] }];

  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}
