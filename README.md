# TOFA

A terminal-first 2FA code manager with encrypted local storage and an interactive setup flow.

## Installation

Install globally using npm:

```bash
npm install -g tofa
```

Or with bun:

```bash
bun install -g tofa
```

## Usage

Start the application:

```bash
tofa
```

On first launch, an interactive setup flow will guide you through creating an encrypted vault. Your codes are stored locally and encrypted:

- **macOS:** `~/Library/Application Support/tofa/vault.json`
- **Linux:** `$XDG_CONFIG_HOME/tofa/vault.json` or `~/.config/tofa/vault.json`

## Development

To set up a development environment:

```bash
bun install
bun dev        # watch mode
bun setup      # create the vault if it does not exist
bun test       # domain tests
bun typecheck  # TypeScript validation
```