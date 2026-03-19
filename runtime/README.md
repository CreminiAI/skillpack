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

After the server starts, your browser opens [http://127.0.0.1:26313](http://127.0.0.1:26313) automatically.

By default, the server only listens on `127.0.0.1` so the API key you enter stays on the local machine and is not exposed to your LAN.

## Managed Restart with PM2

If you want the web UI and bot commands to support in-app restart, run the server under PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
```

Behavior:

- `/restart` or the web restart button exits with restart code `75`; PM2 brings the process back up
- `/shutdown` exits with code `64`; PM2 treats it as a stop and does not auto-restart
- When started via `start.sh` or `start.bat`, restart is manual only

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
