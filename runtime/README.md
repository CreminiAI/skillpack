# Skillapp

## Quick Start

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

### Windows

Double-click `start.bat` or run:

```cmd
start.bat
```

Both launchers install server dependencies locally if needed, then start the app under the bundled PM2 runtime. After the server starts, your browser opens [http://127.0.0.1:26313](http://127.0.0.1:26313) automatically.

By default, the server only listens on `127.0.0.1` so the API key you enter stays on the local machine and is not exposed to your LAN.

## Managed Restart with PM2

`start.sh` and `start.bat` already use PM2. If you want to launch it manually, use the local PM2 binary inside `server/node_modules`:

```bash
./server/node_modules/.bin/pm2 startOrRestart ecosystem.config.cjs --update-env
```

Behavior:

- `/restart` or the web restart button exits with restart code `75`; PM2 brings the process back up
- `/shutdown` exits with code `64`; PM2 treats it as a stop and does not auto-restart
- The PM2 app name is derived from `skillpack.json.name`, falling back to the folder name

## First Use

1. Enter your OpenAI or Anthropic API key in the left sidebar
2. Type a message in the chat box to start a conversation
3. Click a prompt example on the welcome screen to prefill the input

## Requirements

- Node.js >= 20

## Environment Variables

| Variable            | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI API key, optional if you set it in the web UI    |
| `ANTHROPIC_API_KEY` | Anthropic API key, optional if you set it in the web UI |
| `HOST`              | Bind address, defaults to `127.0.0.1`                   |
| `PORT`              | Server port, defaults to `26313`                        |
| `SKILLPACK_PROCESS_MANAGER` | Set to `pm2` when started under PM2             |
