# IRCy - IRC Client

A modern IRC client built with Cloudflare Workers, Durable Objects, and static assets. Inspired by IRCCloud.

## Features

- 🚀 **Cloudflare Workers** - Serverless backend running at the edge
- 💾 **Durable Objects** - Persistent state storage for IRC connections
- 🎨 **Modern UI** - Clean, IRCCloud-inspired interface
- 🔌 **Real-time** - WebSocket-based real-time message updates
- 📱 **Responsive** - Works on desktop and mobile devices

## Architecture

- **Frontend**: Static HTML/CSS/JavaScript served from Cloudflare Workers
- **Backend**: Cloudflare Worker handling HTTP API and WebSocket connections
- **State**: Durable Objects store IRC connection state, channels, and messages
- **IRC Protocol**: Direct TCP connections to IRC servers (using Cloudflare's `connect()` API)

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Cloudflare**:
   - Make sure you have a Cloudflare account
   - Authenticate Wrangler:
     ```bash
     npx wrangler login
     ```

3. **Deploy**:
   ```bash
   npm run deploy
   ```

## Development

Run locally with:
```bash
npm run dev
```

## Usage

1. Open the application in your browser
2. Click the "+" button to add a new connection
3. Enter your IRC server details:
   - **Server**: e.g., `irc.libera.chat`
   - **Port**: e.g., `6697` (for SSL) or `6667` (for non-SSL)
   - **Nickname**: Your IRC nickname
   - **Username** (optional): Your username
   - **Real Name** (optional): Your real name
   - **Password** (optional): Server password if required
4. Click "Connect"
5. Use `/join #channel` to join channels
6. Type messages and press Enter to send

## IRC Commands

- `/join #channel` - Join a channel
- `/part #channel` - Leave a channel
- `/nick NewNick` - Change your nickname
- `/msg Nick Message` - Send a private message
- Any raw IRC command (e.g., `/MODE #channel +o user`)

## Project Structure

```
ircy/
├── src/
│   ├── index.ts          # Main worker entry point
│   └── irc-connection.ts # Durable Object for IRC connections
├── public/
│   ├── index.html        # Frontend HTML
│   ├── styles.css        # Frontend styles
│   └── app.js           # Frontend JavaScript
├── wrangler.toml        # Cloudflare Workers configuration
├── package.json         # Dependencies
└── tsconfig.json        # TypeScript configuration
```

## Limitations & Notes

**Important**: Cloudflare Workers currently has limited support for direct TCP connections to IRC servers. The code uses Cloudflare's `connect()` API which may require:

1. **Cloudflare Workers Paid Plan** - TCP socket support may require a paid plan
2. **Experimental Features** - TCP socket support may be in beta/experimental phase
3. **Alternative Approach** - Consider using a proxy service or Cloudflare Tunnel for IRC connections

For development/testing, you may need to:
- Use Cloudflare's TCP socket API (if available)
- Set up a proxy service that bridges WebSocket to TCP
- Use Cloudflare Tunnel or similar service

Some IRC servers may require specific connection handling. SSL/TLS connections are supported via the secure port (typically 6697).

## License

MIT

