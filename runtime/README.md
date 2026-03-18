# Skillapp

## Quick Start

### macOS / Linux

```bash
chmod +x install.sh && ./install.sh
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

## First Use

1. Enter your OpenAI or Anthropic API key in the left sidebar
2. Type a message in the chat box to start a conversation
3. Click a prompt example on the welcome screen to prefill the input

## Slack Bridge (Events API)

This runtime supports Slack Events API integration with frontend-first setup.

### Frontend-first configuration (local-first)

1. Open the app in your browser.
2. In the left sidebar, fill in:
	 - `Slack Bot Token` (`xoxb-...`)
	 - `Slack Signing Secret`
	 - `Slack App Token` (`xapp-...`, optional)
	 - `Events Path` (default: `/api/slack/events`)
3. Click `Save`.

The UI sends these settings to the local backend at runtime. The page only receives status flags (configured or not), not secret values.
Saved settings are persisted in `.skillpack-runtime/runtime-config.json` in your pack directory.

### One-click local tunnel from UI

Use the `TUNNEL` section in the left sidebar:

1. Select `cloudflared` or `ngrok`
2. Set local port (default `26313`)
3. Click `Start`
4. Copy the generated Slack callback URL with `Copy URL`

Requirements:
- `cloudflared` installed for cloudflared mode
- `ngrok` installed and authenticated for ngrok mode

You can auto-install both with:

```bash
./install.sh
```

### Bind one web session to one Slack thread (1:1)

Use API endpoint:

```bash
curl -X POST http://127.0.0.1:26313/api/slack/mappings \
	-H "Content-Type: application/json" \
	-d '{"sessionId":"<web-session-id>","channelId":"C12345678","threadTs":"1734567890.123456"}'
```

List mappings:

```bash
curl http://127.0.0.1:26313/api/slack/mappings
```

### Slack app callback URL

Configure your Slack app Event Subscriptions request URL to:

`https://<your-domain>/api/slack/events`

For local testing, expose your local server with a tunnel (for example, ngrok/cloudflared) and use the tunneled HTTPS URL.

### Behavior

- Slack inbound: only non-bot message events are considered.
- New unbound thread: requires bot mention (`<@bot>`) to auto-create a mapping.
- Existing bound thread: messages in the mapped thread are forwarded into the mapped web session.
- Web outbound: user/assistant messages from a mapped web session are mirrored into the mapped Slack thread.

## Requirements

- Node.js >= 20

## Environment Variables

| Variable            | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI API key, optional if you set it in the web UI    |
| `ANTHROPIC_API_KEY` | Anthropic API key, optional if you set it in the web UI |
| `HOST`              | Bind address, defaults to `127.0.0.1`                   |
| `PORT`              | Server port, defaults to `26313`                        |
| `SLACK_BOT_TOKEN`   | Slack bot token (`xoxb-...`), optional if set in UI     |
| `SLACK_SIGNING_SECRET` | Slack signing secret, optional if set in UI          |
| `SLACK_APP_TOKEN`   | Slack app token (`xapp-...`), optional                   |
| `SLACK_EVENTS_PATH` | Events path (default: `/api/slack/events`)              |
