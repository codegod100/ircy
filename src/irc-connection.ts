import { connect } from "cloudflare:sockets";

export interface IRCMessage {
  id: string;
  timestamp: number;
  type: "message" | "join" | "part" | "quit" | "nick" | "mode" | "notice" | "error";
  channel?: string;
  user?: string;
  message?: string;
  raw?: string;
}

export interface IRCChannel {
  name: string;
  messages: IRCMessage[];
  topic?: string;
  users: string[];
}

export interface IRCSocket {
  send: (data: string) => Promise<void>;
  close: () => void;
}

export interface IRCConnectionState {
  server: string;
  port: number;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  connected: boolean;
  channels: Map<string, IRCChannel>;
  buffer: IRCMessage[];
  socket?: IRCSocket;
  lastActivity: number;
}

interface Env {
  IRC_CONNECTION: DurableObjectNamespace;
}

export class IRCConnection {
  private state: IRCConnectionState | null = null;
  private websockets: Set<WebSocket> = new Set();
  private messageBuffer: any[] = []; // Buffer recent messages for new WebSocket connections
  private ircConnectionStarted: boolean = false; // Track if IRC connection has been initiated

  constructor(private ctx: DurableObjectState, private env: Env) {}

  private async ensureStateLoaded(): Promise<void> {
    if (this.state !== null) return; // Already loaded

    // Try to load state from storage
    const stored = await this.ctx.storage.get<any>("state");
    if (stored) {
      // Convert plain object back to Map and reconstruct IRCChannel objects
      const channelsMap = new Map<string, IRCChannel>();
      if (stored.channels) {
        for (const [name, channelData] of Object.entries(stored.channels)) {
          const channel = channelData as any;
          const messageCount = channel.messages?.length || 0;
          console.log(`Loading channel ${name} with ${messageCount} messages`);
          channelsMap.set(name, {
            name: channel.name || name,
            messages: channel.messages || [],
            topic: channel.topic,
            users: channel.users || [],
          });
        }
      }
      
      this.state = {
        ...stored,
        channels: channelsMap,
        buffer: stored.buffer || [],
        socket: undefined, // Don't restore socket connection
      };
      console.log(`Loaded state from storage: ${channelsMap.size} channels, ${stored.buffer?.length || 0} buffer messages`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // Handle API requests
    if (url.pathname === "/connect") {
      return this.handleConnect(request);
    }

    if (url.pathname === "/disconnect") {
      return this.handleDisconnect(request);
    }

    if (url.pathname === "/send") {
      return this.handleSend(request);
    }

    if (url.pathname === "/state") {
      return this.handleGetState(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    // Ensure state is loaded before handling WebSocket
    await this.ensureStateLoaded();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server);
    this.websockets.add(server);
    console.log(`WebSocket added. Total WebSockets: ${this.websockets.size}`);

    // If we have a connection request pending and this is the first WebSocket, start IRC connection
    // Also reconnect if IRC connection was lost
    if (this.state && !this.state.connected && this.websockets.size === 1) {
      // Reset connection started flag if connection was lost
      if (!this.state.connected) {
        this.ircConnectionStarted = false;
      }
      
      if (!this.ircConnectionStarted) {
        console.log('First WebSocket connected, starting IRC connection now');
        this.ircConnectionStarted = true;
        this.connectToIRC().catch((error) => {
          this.broadcast({ type: "error", error: String(error) });
          this.ircConnectionStarted = false; // Reset on error so we can retry
        });
      }
    }

    server.addEventListener("close", () => {
      this.websockets.delete(server);
      console.log(`WebSocket removed. Total WebSockets: ${this.websockets.size}`);
    });

    server.addEventListener("error", () => {
      this.websockets.delete(server);
      console.log(`WebSocket error, removed. Total WebSockets: ${this.websockets.size}`);
    });

    // Send current state to new client
    if (this.state) {
      server.send(JSON.stringify({
        type: "state",
        state: this.serializeState()
      }));

      // Send all channel messages to restore full history
      for (const [channelName, channel] of this.state.channels.entries()) {
        const messages = channel.messages || [];
        console.log(`Sending ${messages.length} messages for channel ${channelName}`, messages.map(m => ({ id: m.id, user: m.user, message: m.message?.substring(0, 20) })));
        // Send channel history restoration message
        server.send(JSON.stringify({
          type: "channel_history",
          channel: channelName,
          messages: messages.slice(-500), // Send last 500 messages per channel
        }));
      }

      // Send buffered messages (non-channel messages) to new client (last 100 messages)
      const recentMessages = this.messageBuffer.slice(-100);
      for (const msg of recentMessages) {
        try {
          // Only send non-channel messages from buffer (channel messages are sent above)
          if (msg.type !== "message" || !msg.message?.channel) {
            server.send(JSON.stringify(msg));
          }
        } catch (e) {
          // Ignore errors
        }
      }
    } else {
      // Send initial connection status
      server.send(JSON.stringify({
        type: "status",
        message: "Waiting for connection..."
      }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleConnect(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        server: string;
        port: number;
        nick: string;
        username?: string;
        realname?: string;
        password?: string;
      };

      // Load state from storage
      const stored = await this.ctx.storage.get<any>("state");
      if (stored) {
        // Convert plain object back to Map and reconstruct IRCChannel objects
        const channelsMap = new Map<string, IRCChannel>();
        if (stored.channels) {
          for (const [name, channelData] of Object.entries(stored.channels)) {
            const channel = channelData as any;
            const messageCount = channel.messages?.length || 0;
            console.log(`handleConnect: Loading channel ${name} with ${messageCount} messages`);
            channelsMap.set(name, {
              name: channel.name || name,
              messages: channel.messages || [],
              topic: channel.topic,
              users: channel.users || [],
            });
          }
        }
        
        this.state = {
          ...stored,
          channels: channelsMap,
          buffer: stored.buffer || [],
        };
        console.log(`handleConnect: Loaded state with ${channelsMap.size} channels`);
      } else {
        this.state = {
          server: body.server,
          port: body.port,
          nick: body.nick,
          username: body.username || body.nick,
          realname: body.realname || body.nick,
          password: body.password,
          connected: false,
          channels: new Map(),
          buffer: [],
          lastActivity: Date.now(),
        };
      }

      // Mark that we want to connect to IRC
      // The actual connection will be triggered when the first WebSocket connects
      this.ircConnectionStarted = false;

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ 
        error: error?.message || "Failed to connect",
        details: String(error)
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleDisconnect(request: Request): Promise<Response> {
    if (this.state?.socket) {
      this.state.socket.close();
      this.state.socket = undefined;
    }
    this.state = null;
    await this.ctx.storage.deleteAll();

    this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleSend(request: Request): Promise<Response> {
    const body = await request.json() as {
      channel?: string;
      message: string;
    };

    if (!this.state?.socket || !this.state.connected) {
      return new Response(JSON.stringify({ error: "Not connected" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.channel) {
      // Send the PRIVMSG
      this.sendIRC(`PRIVMSG ${body.channel} :${body.message}`);
      
      // Create optimistic message in case server echo doesn't arrive
      // The server echo will replace this if it arrives
      const optimisticMessage: IRCMessage = {
        id: `optimistic-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
        type: "message",
        channel: body.channel,
        user: this.state.nick, // Use our own nick for optimistic message
        message: body.message,
        raw: `PRIVMSG ${body.channel} :${body.message}`,
      };
      
      // Add to channel immediately (server echo will update if it arrives)
      if (!this.state.channels.has(body.channel)) {
        this.state.channels.set(body.channel, {
          name: body.channel,
          messages: [],
          users: [],
        });
      }
      const channel = this.state.channels.get(body.channel)!;
      channel.messages.push(optimisticMessage);
      if (channel.messages.length > 1000) {
        channel.messages.shift();
      }
      
      // Broadcast optimistic message
      this.broadcast({ type: "message", message: optimisticMessage });
      
      // Save state immediately
      this.state.lastActivity = Date.now();
      this.saveState().catch(err => {
        console.error('Error saving optimistic message:', err);
      });
    } else {
      this.sendIRC(body.message);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetState(request: Request): Promise<Response> {
    // Ensure state is loaded
    await this.ensureStateLoaded();
    return new Response(JSON.stringify(this.serializeState()), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async waitForWebSocketAndConnect(): Promise<void> {
    // Wait for at least one WebSocket to connect (max 10 seconds)
    const maxWait = 10000;
    const checkInterval = 50;
    let waited = 0;

    console.log(`Waiting for WebSocket connection. Current WebSockets: ${this.websockets.size}`);

    while (this.websockets.size === 0 && waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
      if (waited % 500 === 0) {
        console.log(`Still waiting for WebSocket... (${waited}ms elapsed, ${this.websockets.size} connected)`);
      }
    }

    if (this.websockets.size > 0) {
      console.log(`✓ WebSocket connected! Starting IRC connection (waited ${waited}ms, ${this.websockets.size} WebSocket(s))`);
    } else {
      console.warn(`⚠ No WebSocket connected after ${waited}ms, starting IRC connection anyway`);
    }

    // Start IRC connection
    this.connectToIRC().catch((error) => {
      this.broadcast({ type: "error", error: String(error) });
    });
  }

  private async connectToIRC(): Promise<void> {
    if (!this.state) return;

    try {
      this.broadcast({ type: "status", message: `Connecting to ${this.state.server}:${this.state.port}...` });

      // Use Cloudflare's connect() API for TCP connections
      // For IRC, port 6697 typically uses TLS, port 6667 is plain TCP
      const useTLS = this.state.port === 6697 || this.state.port === 994 || this.state.port === 7000;
      
      const socket = connect(
        { hostname: this.state.server, port: this.state.port },
        { 
          secureTransport: useTLS ? "on" : "off",
          allowHalfOpen: false
        }
      );

      // Wait for socket to open
      await socket.opened;
      
      // Create a readable/writable stream wrapper
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      
      this.state.socket = {
        send: async (data: string) => {
          const encoder = new TextEncoder();
          await writer.write(encoder.encode(data));
        },
        close: async () => {
          reader.cancel();
          await writer.close();
          await socket.close();
        },
      };

      this.state.connected = true;
      this.state.lastActivity = Date.now();

      this.broadcast({ type: "status", message: "TCP connection established, authenticating..." });

      // Send authentication
      if (this.state.password) {
        await this.sendIRC(`PASS ${this.state.password}`);
      }
      await this.sendIRC(`NICK ${this.state.nick}`);
      await this.sendIRC(`USER ${this.state.username} 0 * :${this.state.realname}`);

      this.broadcast({ type: "connected", message: "Connected to IRC server" });
      this.saveState();

      // Read messages from socket (don't await - run in background)
      this.readFromSocket(reader).catch((error) => {
        console.error("Error reading from socket:", error);
        this.state!.connected = false;
        this.ircConnectionStarted = false; // Reset flag so we can reconnect when WebSocket reconnects
        this.broadcast({ type: "error", error: `Socket read error: ${String(error)}` });
        this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
        this.saveState();
      });

      // Handle socket closure
      socket.closed.then(() => {
        console.log("Socket closed");
        this.state!.connected = false;
        this.ircConnectionStarted = false; // Reset flag so we can reconnect when WebSocket reconnects
        this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
        this.saveState();
      }).catch((error) => {
        console.error("Socket closed with error:", error);
        this.state!.connected = false;
        this.ircConnectionStarted = false; // Reset flag so we can reconnect when WebSocket reconnects
        this.broadcast({ type: "error", error: `Socket closed: ${String(error)}` });
        this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
        this.saveState();
      });

    } catch (error) {
      const errorMsg = String(error);
      console.error("IRC connection error:", errorMsg);
      this.broadcast({ type: "error", error: errorMsg });
      this.state!.connected = false;
      this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
    }
  }

  private async readFromSocket(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("Socket stream ended");
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\r\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            console.log("IRC raw received:", line);
            // Broadcast raw IRC message for server log (incoming)
            this.broadcast({ type: "raw", message: `→ ${line}` });
            this.handleIRCMessage(line + "\r\n");
          }
        }
      }
    } catch (error) {
      console.error("Socket read error:", error);
      this.state!.connected = false;
      this.broadcast({ type: "error", error: `Socket read error: ${String(error)}` });
      this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
      this.saveState();
    }
  }

  private async sendIRC(message: string): Promise<void> {
    if (this.state?.socket && this.state.connected) {
      const fullMessage = message + "\r\n";
      // Broadcast outgoing IRC message for server log (without \r\n)
      this.broadcast({ type: "raw", message: `← ${message}` });
      console.log("Sending IRC:", message);
      await this.state.socket.send(fullMessage);
      this.state.lastActivity = Date.now();
    } else {
      console.log("Cannot send IRC - not connected. Socket:", !!this.state?.socket, "Connected:", this.state?.connected);
    }
  }

  private handleIRCMessage(raw: string): void {
    if (!this.state) return;

    const lines = raw.split("\r\n").filter(line => line.trim());
    
    for (const line of lines) {
      if (line.startsWith("PING")) {
        const server = line.split(" ")[1];
        this.sendIRC(`PONG ${server}`);
        continue;
      }

      // Log all incoming IRC messages for debugging
      if (line.includes("PRIVMSG")) {
        console.log("IRC raw received (PRIVMSG):", line);
      }

      const message = this.parseIRCMessage(line);
      if (message) {
        // Add to buffer
        this.state.buffer.push(message);
        if (this.state.buffer.length > 1000) {
          this.state.buffer.shift();
        }

        // Add to channel if applicable
        if (message.channel) {
          if (!this.state.channels.has(message.channel)) {
            this.state.channels.set(message.channel, {
              name: message.channel,
              messages: [],
              users: [],
            });
          }
          const channel = this.state.channels.get(message.channel)!;
          
          // Check if this is a duplicate (server echo of optimistic message)
          // Look for optimistic message with same content and user within last 5 seconds
          let replacedOptimistic = false;
          let shouldBroadcast = true;
          
          for (let idx = channel.messages.length - 1; idx >= 0; idx--) {
            const existingMsg = channel.messages[idx];
            if (existingMsg.id?.startsWith('optimistic-') && 
                existingMsg.user === message.user &&
                existingMsg.message === message.message &&
                Math.abs(existingMsg.timestamp - message.timestamp) < 5000) {
              // Replace optimistic message with server echo
              channel.messages[idx] = message;
              replacedOptimistic = true;
              shouldBroadcast = false; // Don't broadcast duplicate
              break;
            }
          }
          
          if (!replacedOptimistic) {
            // Only add if not a duplicate of any existing message
            const isDuplicate = channel.messages.some(existingMsg => 
              existingMsg.user === message.user &&
              existingMsg.message === message.message &&
              Math.abs(existingMsg.timestamp - message.timestamp) < 2000
            );
            
            if (!isDuplicate) {
              channel.messages.push(message);
              if (channel.messages.length > 1000) {
                channel.messages.shift();
              }
            } else {
              shouldBroadcast = false; // Don't broadcast duplicate
            }
          }
          
          console.log(`Added message to channel ${message.channel}, total messages: ${channel.messages.length}`, {
            user: message.user,
            message: message.message?.substring(0, 30),
            id: message.id,
            replacedOptimistic
          });
          
          // Save state immediately for channel messages to ensure persistence
          this.state.lastActivity = Date.now();
          this.saveState().then(() => {
            console.log(`State saved after adding message to ${message.channel}, channel now has ${channel.messages.length} messages`);
          }).catch(err => {
            console.error('Error saving state:', err);
          });
          
          // Broadcast only if not a duplicate
          if (shouldBroadcast) {
            this.broadcast({ type: "message", message: message });
          }
        } else {
          this.state.lastActivity = Date.now();
          // Save state for non-channel messages too, but less frequently
          this.saveState().catch(err => {
            console.error('Error saving state:', err);
          });
          
          // Broadcast to WebSocket clients
          this.broadcast({ type: "message", message: message });
        }
      }
    }
  }

  private parseIRCMessage(line: string): IRCMessage | null {
    const id = `${Date.now()}-${Math.random()}`;
    const timestamp = Date.now();

    // Parse IRC message format: :prefix COMMAND params :trailing
    const match = line.match(/^(?::([^ ]+) )?([A-Z0-9]+)(?: (.*))?$/);
    if (!match) return null;

    const [, prefix, command, params] = match;
    const parts = params ? params.split(" :") : [];
    const trailing = parts.length > 1 ? parts.slice(1).join(" :") : undefined;
    const paramParts = parts[0] ? parts[0].split(" ") : [];

    const user = prefix ? prefix.split("!")[0] : undefined;

    switch (command) {
      case "PRIVMSG":
        return {
          id,
          timestamp,
          type: "message",
          channel: paramParts[0],
          user,
          message: trailing,
          raw: line,
        };

      case "JOIN":
        return {
          id,
          timestamp,
          type: "join",
          channel: trailing || paramParts[0],
          user,
          raw: line,
        };

      case "PART":
        return {
          id,
          timestamp,
          type: "part",
          channel: paramParts[0],
          user,
          message: trailing,
          raw: line,
        };

      case "QUIT":
        return {
          id,
          timestamp,
          type: "quit",
          user,
          message: trailing,
          raw: line,
        };

      case "NICK":
        return {
          id,
          timestamp,
          type: "nick",
          user,
          message: trailing || paramParts[0],
          raw: line,
        };

      case "NOTICE":
        return {
          id,
          timestamp,
          type: "notice",
          channel: paramParts[0]?.startsWith("#") ? paramParts[0] : undefined,
          user,
          message: trailing,
          raw: line,
        };

      case "001": // RPL_WELCOME
      case "002": // RPL_YOURHOST
      case "003": // RPL_CREATED
      case "004": // RPL_MYINFO
        return {
          id,
          timestamp,
          type: "notice",
          message: trailing,
          raw: line,
        };

      case "353": // RPL_NAMREPLY - channel user list
        const channel = paramParts[2];
        const users = trailing?.split(" ").filter(u => u) || [];
        if (channel && this.state) {
          if (!this.state.channels.has(channel)) {
            this.state.channels.set(channel, {
              name: channel,
              messages: [],
              users: [],
            });
          }
          const chan = this.state.channels.get(channel)!;
          // Append users (may come in multiple 353 messages)
          users.forEach(user => {
            const cleanUser = user.replace(/^[@+]/, ''); // Remove channel prefixes
            if (!chan.users.includes(cleanUser)) {
              chan.users.push(cleanUser);
            }
          });
        }
        return null;

      case "332": // RPL_TOPIC
        const topicChannel = paramParts[1];
        if (topicChannel && this.state) {
          if (!this.state.channels.has(topicChannel)) {
            this.state.channels.set(topicChannel, {
              name: topicChannel,
              messages: [],
              users: [],
            });
          }
          this.state.channels.get(topicChannel)!.topic = trailing;
        }
        return null;

      default:
        return {
          id,
          timestamp,
          type: "notice",
          message: line,
          raw: line,
        };
    }
  }

  private broadcast(data: any): void {
    // Add to message buffer (keep last 200 messages)
    this.messageBuffer.push(data);
    if (this.messageBuffer.length > 200) {
      this.messageBuffer.shift();
    }

    const message = JSON.stringify(data);
    const messagePreview = typeof data.message === 'string' ? data.message.substring(0, 50) : String(data.message || '');
    console.log("Broadcasting to", this.websockets.size, "WebSocket(s):", data.type, messagePreview);
    for (const ws of this.websockets) {
      try {
        ws.send(message);
      } catch (e) {
        console.error("Error broadcasting to WebSocket:", e);
        // WebSocket might be closed
        this.websockets.delete(ws);
      }
    }
  }

  private serializeState(): any {
    if (!this.state) return null;

    return {
      server: this.state.server,
      port: this.state.port,
      nick: this.state.nick,
      connected: this.state.connected,
      channels: Array.from(this.state.channels.entries()).map(([name, channel]) => ({
        name,
        topic: channel.topic,
        messageCount: channel.messages.length,
        userCount: channel.users.length,
      })),
      bufferSize: this.state.buffer.length,
      lastActivity: this.state.lastActivity,
    };
  }

  private saveStatePromise: Promise<void> | null = null;

  private async saveState(): Promise<void> {
    if (!this.state) return;

    // If a save is already in progress, wait for it and then save again
    if (this.saveStatePromise) {
      await this.saveStatePromise;
    }

    // Convert Map to plain object for storage
    const stateToSave: any = {
      ...this.state,
      channels: Object.fromEntries(
        Array.from(this.state.channels.entries()).map(([name, channel]) => {
          const messageCount = channel.messages.length;
          console.log(`Saving channel ${name} with ${messageCount} messages`);
          return [
            name,
            {
              ...channel,
              messages: channel.messages.slice(-500), // Keep last 500 messages
            },
          ];
        })
      ),
      buffer: this.state.buffer.slice(-500), // Keep last 500 messages
    };

    this.saveStatePromise = this.ctx.storage.put("state", stateToSave).then(() => {
      console.log(`State saved: ${Object.keys(stateToSave.channels).length} channels`);
      this.saveStatePromise = null;
    }).catch(err => {
      console.error('Error saving state:', err);
      this.saveStatePromise = null;
      throw err;
    });

    return this.saveStatePromise;
  }
}

