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

Both launchers install server dependencies locally if needed, then start the app in the foreground. After the server starts, your browser opens [http://127.0.0.1:26313](http://127.0.0.1:26313) automatically.

By default, the server only listens on `127.0.0.1` so the API key you enter stays on the local machine and is not exposed to your LAN.

## Process Management

`start.sh` runs the server in a wrapper loop that monitors the exit code:

- `/restart` or the web restart button exits with code `75`; the wrapper relaunches the process
- `/shutdown` exits with code `64`; the wrapper treats it as a clean stop and exits
- Any other exit code (e.g. crash) triggers an automatic restart after 2 seconds

All server output (logs and errors) appears directly in the terminal.

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
