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
  close: () => Promise<void>;
}

export interface IRCConnectionState {
  server: string;
  port: number;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  sasl?: {
    mechanism: string; // "PLAIN", "EXTERNAL", etc.
    username?: string;
    password?: string;
  };
  connected: boolean;
  channels: Map<string, IRCChannel>;
  buffer: IRCMessage[];
  socket?: IRCSocket;
  lastActivity: number;
  keepAlive?: boolean; // If true, use alarms to prevent hibernation (costs ~$410/month)
  capNegotiation?: {
    enabled: boolean;
    saslRequested: boolean;
    saslAccepted: boolean;
    waitingForAuthenticate: boolean;
  };
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

  // Durable Object alarm handler - called when alarm fires
  // This prevents hibernation to keep IRC connection alive for bouncer functionality
  async alarm(): Promise<void> {
    await this.ensureStateLoaded();
    
    // If IRC is connected, schedule next alarm to prevent hibernation
    // This keeps the Durable Object alive so IRC connection persists
    if (this.state?.connected) {
      // Schedule next alarm in 20 seconds (before 30s hibernation threshold)
      const nextAlarm = Date.now() + 20000;
      await this.ctx.storage.setAlarm(nextAlarm);
      console.log('Alarm: IRC still connected, scheduling next alarm to prevent hibernation');
    } else {
      console.log('Alarm: IRC not connected, not scheduling next alarm');
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
    // Also reconnect if IRC connection was lost (e.g., after Durable Object hibernation)
    if (this.state && !this.state.connected && this.websockets.size === 1) {
      // Reset connection started flag if connection was lost
      if (!this.state.connected) {
        this.ircConnectionStarted = false;
      }
      
      if (!this.ircConnectionStarted) {
        console.log('First WebSocket connected, starting IRC connection now (reconnecting after hibernation if needed)');
        this.ircConnectionStarted = true;
        this.connectToIRC().catch((error) => {
          this.broadcast({ type: "error", error: String(error) });
          this.ircConnectionStarted = false; // Reset on error so we can retry
        });
      }
    }
    
    // If IRC is already connected, we're good (Durable Object didn't hibernate)
    // If not connected, the above logic will reconnect

    server.addEventListener("close", () => {
      this.websockets.delete(server);
      console.log(`WebSocket removed. Total WebSockets: ${this.websockets.size}`);
      // Note: IRC connection stays open even when all clients disconnect
      // It will only close if the Durable Object hibernates or there's an error
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
        // Send channel history restoration message with users
        server.send(JSON.stringify({
          type: "channel_history",
          channel: channelName,
          messages: messages.slice(-500), // Send last 500 messages per channel
          users: channel.users || [], // Send user list
          topic: channel.topic,
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
        sasl?: {
          mechanism: string;
          username?: string;
          password?: string;
        };
        keepAlive?: boolean; // If true, prevents hibernation (~324k GB-s/month, within free tier)
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
          sasl: body.sasl,
          connected: false,
          channels: new Map(),
          buffer: [],
          lastActivity: Date.now(),
        };
      }

      // Update SASL if provided (even if state was loaded)
      if (body.sasl) {
        this.state.sasl = body.sasl;
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
      await this.state.socket.close();
      this.state.socket = undefined;
    }
    
    // Cancel alarms since we're disconnecting
    try {
      await this.ctx.storage.deleteAlarm();
    } catch (e) {
      // Ignore if no alarm exists
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

      // Initialize CAP negotiation state if using SASL
      if (this.state.sasl) {
        this.state.capNegotiation = {
          enabled: true,
          saslRequested: false,
          saslAccepted: false,
          waitingForAuthenticate: false,
        };
        // Request CAP LS to see what capabilities are available
        await this.sendIRC("CAP LS 302");
        
        // Set a timeout to complete authentication if CAP negotiation stalls
        setTimeout(() => {
          if (this.state?.capNegotiation?.enabled && !this.state.capNegotiation.saslAccepted) {
            console.log("CAP negotiation timeout - ending CAP and completing authentication");
            this.sendIRC("CAP END");
            this.state.capNegotiation.enabled = false;
            this.completeAuthentication();
          }
        }, 10000); // 10 second timeout
      } else {
        // Traditional authentication without SASL
        // Don't send CAP LS - just authenticate directly
        if (this.state.password) {
          await this.sendIRC(`PASS ${this.state.password}`);
        }
        await this.sendIRC(`NICK ${this.state.nick}`);
        await this.sendIRC(`USER ${this.state.username || this.state.nick} 0 * :${this.state.realname || this.state.nick}`);
        this.broadcast({ type: "connected", message: "Connected to IRC server" });
      }
      
      // Auto-join channels that were previously joined
      if (this.state.channels.size > 0) {
        console.log(`Auto-joining ${this.state.channels.size} channels`);
        for (const channelName of this.state.channels.keys()) {
          await this.sendIRC(`JOIN ${channelName}`);
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // Schedule alarm to prevent hibernation ONLY if keepAlive is enabled
      // A single 24/7 connection uses ~324k GB-s/month (within 400k free tier = $0/month)
      // See: https://developers.cloudflare.com/durable-objects/platform/pricing/
      if (this.state.keepAlive) {
        const nextAlarm = Date.now() + 20000;
        await this.ctx.storage.setAlarm(nextAlarm);
        console.log('IRC connected with keepAlive enabled, scheduled alarm to prevent hibernation');
      } else {
        console.log('IRC connected without keepAlive - will hibernate after ~30s of inactivity (messages may be lost)');
      }
      
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
      socket.closed.then(async () => {
        console.log("Socket closed");
        this.state!.connected = false;
        this.ircConnectionStarted = false; // Reset flag so we can reconnect when WebSocket reconnects
        // Cancel alarms since IRC disconnected
        try {
          await this.ctx.storage.deleteAlarm();
        } catch (e) {
          // Ignore if no alarm exists
        }
        this.broadcast({ type: "disconnected", message: "Disconnected from IRC server" });
        this.saveState();
      }).catch(async (error) => {
        console.error("Socket closed with error:", error);
        this.state!.connected = false;
        this.ircConnectionStarted = false; // Reset flag so we can reconnect when WebSocket reconnects
        // Cancel alarms since IRC disconnected
        try {
          await this.ctx.storage.deleteAlarm();
        } catch (e) {
          // Ignore if no alarm exists
        }
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

      // Handle CAP and AUTHENTICATE commands before parsing
      // CAP messages can be :server CAP * LS :... or CAP * LS :...
      // Check if line contains CAP command by splitting and checking
      const parts = line.split(" ");
      const capIndex = parts.findIndex(p => p === "CAP");
      if (capIndex >= 0) {
        console.log(`Found CAP at index ${capIndex}, parts:`, parts);
        if (capIndex + 2 < parts.length) {
          const subcommand = parts[capIndex + 2];
          console.log(`CAP subcommand: ${subcommand}`);
          if (["LS", "ACK", "NAK", "LIST", "END"].includes(subcommand)) {
            console.log("Handling CAP message:", line);
            this.handleCAP(line);
            continue;
          }
        } else {
          console.log(`CAP found but not enough parts (capIndex=${capIndex}, parts.length=${parts.length})`);
        }
      }
      // AUTHENTICATE can be :server AUTHENTICATE + or AUTHENTICATE +
      if (line.includes("AUTHENTICATE")) {
        console.log("Handling AUTHENTICATE message:", line);
        this.handleAUTHENTICATE(line);
        continue;
      }

      const message = this.parseIRCMessage(line);
      if (message) {
        // Add to buffer
        this.state.buffer.push(message);
        if (this.state.buffer.length > 1000) {
          this.state.buffer.shift();
        }

        // Handle JOIN/PART messages to update user lists
        if (message.type === "join" && message.channel && message.user) {
          if (!this.state.channels.has(message.channel)) {
            this.state.channels.set(message.channel, {
              name: message.channel,
              messages: [],
              users: [],
            });
            // Save state when new channel is created
            this.state.lastActivity = Date.now();
            this.saveState().catch(err => {
              console.error('Error saving state after channel join:', err);
            });
          }
          const channel = this.state.channels.get(message.channel)!;
          if (!channel.users.includes(message.user)) {
            channel.users.push(message.user);
            channel.users.sort();
            // Broadcast user list update
            this.broadcast({ 
              type: "userlist", 
              channel: message.channel,
              users: channel.users 
            });
          }
          // Broadcast JOIN message so frontend can add channel to UI
          this.broadcast({ type: "message", message: message });
        } else if (message.type === "part" && message.channel && message.user) {
          if (this.state.channels.has(message.channel)) {
            const channel = this.state.channels.get(message.channel)!;
            const index = channel.users.indexOf(message.user);
            if (index > -1) {
              channel.users.splice(index, 1);
              // Broadcast user list update
              this.broadcast({ 
                type: "userlist", 
                channel: message.channel,
                users: channel.users 
              });
            }
          }
          // Broadcast PART message so frontend can update UI
          this.broadcast({ type: "message", message: message });
        } else if (message.type === "quit" && message.user) {
          // Remove user from all channels
          for (const [channelName, channel] of this.state.channels.entries()) {
            const index = channel.users.indexOf(message.user);
            if (index > -1) {
              channel.users.splice(index, 1);
              // Broadcast user list update
              this.broadcast({ 
                type: "userlist", 
                channel: channelName,
                users: channel.users 
              });
            }
          }
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
          
          // Only add messages (not JOIN/PART/QUIT) to message list
          if (message.type === "message") {
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

  private handleCAP(line: string): void {
    if (!this.state || !this.state.capNegotiation) {
      console.log("handleCAP called but capNegotiation not initialized");
      return;
    }

    // Parse CAP message: :server CAP * LS :sasl multi-prefix ...
    // Format can be: :server CAP * LS or CAP * LS
    const parts = line.split(" ");
    const capIndex = parts.findIndex(p => p === "CAP");
    if (capIndex < 0 || capIndex + 2 >= parts.length) {
      console.error("Invalid CAP message format:", line);
      return;
    }
    const subcommand = parts[capIndex + 2]; // LS, ACK, NAK, LIST, etc. (2 positions after CAP)
    
    // Extract capabilities string (everything after the last ":")
    const lastColonIndex = line.lastIndexOf(" :");
    const capabilitiesStr = lastColonIndex >= 0 ? line.substring(lastColonIndex + 2) : "";
    const capabilities = capabilitiesStr.split(" ").filter(c => c.length > 0);

    console.log(`CAP ${subcommand}:`, capabilities);
    console.log(`CAP capabilities string: "${capabilitiesStr}"`);

    // Helper to check if SASL is available (can be "sasl" or "sasl=PLAIN,EXTERNAL,...")
    const hasSASL = capabilities.some(cap => cap.startsWith("sasl"));

    if (subcommand === "LS") {
      // Server sent capability list
      console.log(`CAP LS: hasSASL=${hasSASL}, this.state.sasl=`, this.state.sasl);
      if (hasSASL && this.state.sasl && this.state.sasl.username && this.state.sasl.password) {
        // Request SASL capability
        console.log("SASL detected and configured, requesting capability");
        this.sendIRC("CAP REQ :sasl");
        this.state.capNegotiation.saslRequested = true;
      } else {
        // No SASL support, not configured, or missing credentials - proceed with normal auth
        if (hasSASL && this.state.sasl && (!this.state.sasl.username || !this.state.sasl.password)) {
          console.log("SASL configured but missing credentials, ending CAP");
        } else if (hasSASL && !this.state.sasl) {
          console.log("Server supports SASL but not configured, ending CAP");
        } else {
          console.log("No SASL support, ending CAP");
        }
        this.sendIRC("CAP END");
        this.state.capNegotiation.enabled = false;
        this.completeAuthentication();
      }
    } else if (subcommand === "ACK") {
      // Server acknowledged our capability request
      if (hasSASL) {
        this.state.capNegotiation.saslAccepted = true;
        console.log("SASL capability accepted, starting authentication");
        // Start SASL authentication
        if (this.state.sasl?.mechanism === "PLAIN") {
          this.sendIRC("AUTHENTICATE PLAIN");
          this.state.capNegotiation.waitingForAuthenticate = true;
        }
      } else {
        // SASL not in ACK, end CAP and proceed
        console.log("SASL not in ACK, ending CAP");
        this.sendIRC("CAP END");
        this.state.capNegotiation.enabled = false;
        this.completeAuthentication();
      }
    } else if (subcommand === "NAK") {
      // Server rejected our capability request
      console.log("SASL capability rejected, falling back to normal auth");
      this.sendIRC("CAP END");
      this.state.capNegotiation.enabled = false;
      this.completeAuthentication();
    }
  }

  private handleAUTHENTICATE(line: string): void {
    if (!this.state || !this.state.capNegotiation || !this.state.sasl) return;

    const parts = line.split(" ");
    const response = parts[1];

    if (response === "+") {
      // Server is ready for authentication data
      if (this.state.sasl.mechanism === "PLAIN" && this.state.sasl.username && this.state.sasl.password) {
        // Encode credentials: \0username\0password in base64
        const credentials = `\0${this.state.sasl.username}\0${this.state.sasl.password}`;
        const encoded = btoa(credentials);
        // AUTHENTICATE can only send 400 bytes at a time, so split if needed
        if (encoded.length <= 400) {
          this.sendIRC(`AUTHENTICATE ${encoded}`);
        } else {
          // Send in chunks (shouldn't happen for normal credentials, but handle it)
          const chunk1 = encoded.substring(0, 400);
          this.sendIRC(`AUTHENTICATE ${chunk1}`);
          // Remaining chunks would be sent in subsequent AUTHENTICATE + responses
        }
        console.log("Sent SASL PLAIN authentication");
      }
    } else if (response === "903" || response === "904" || response === "905" || response === "906" || response === "907") {
      // SASL authentication result
      // 903 = success, 904-907 = various failures
      if (response === "903") {
        console.log("SASL authentication successful");
        // End CAP negotiation and complete authentication
        this.sendIRC("CAP END");
        this.state.capNegotiation.enabled = false;
        this.completeAuthentication();
      } else {
        console.error(`SASL authentication failed: ${response}`);
        this.broadcast({ type: "error", error: `SASL authentication failed: ${response}` });
        // End CAP negotiation anyway
        this.sendIRC("CAP END");
        this.state.capNegotiation.enabled = false;
        this.completeAuthentication();
      }
    }
  }

  private completeAuthentication(): void {
    if (!this.state) return;

    // Send NICK and USER commands
    this.sendIRC(`NICK ${this.state.nick}`);
    this.sendIRC(`USER ${this.state.username || this.state.nick} 0 * :${this.state.realname || this.state.nick}`);
    this.broadcast({ type: "connected", message: "Connected to IRC server" });
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

      case "903": // RPL_SASLSUCCESS - SASL authentication successful
        if (this.state?.capNegotiation?.enabled && this.state.capNegotiation.waitingForAuthenticate) {
          console.log("SASL authentication successful (903)");
          // End CAP negotiation and complete authentication
          this.sendIRC("CAP END");
          this.state.capNegotiation.enabled = false;
          this.state.capNegotiation.waitingForAuthenticate = false;
          this.completeAuthentication();
        }
        return {
          id,
          timestamp,
          type: "notice",
          message: trailing,
          raw: line,
        };
      case "904": // ERR_SASLFAIL - SASL authentication failed
      case "905": // ERR_SASLTOOLONG - SASL message too long
      case "906": // ERR_SASLABORTED - SASL authentication aborted
      case "907": // ERR_SASLALREADY - SASL authentication already completed
        if (this.state?.capNegotiation?.enabled) {
          console.error(`SASL authentication failed: ${command}`);
          this.broadcast({ type: "error", error: `SASL authentication failed: ${command} - ${trailing}` });
          // End CAP negotiation anyway
          this.sendIRC("CAP END");
          this.state.capNegotiation.enabled = false;
          this.state.capNegotiation.waitingForAuthenticate = false;
          this.completeAuthentication();
        }
        return {
          id,
          timestamp,
          type: "error",
          message: trailing,
          raw: line,
        };
      case "001": // RPL_WELCOME
        // After welcome, if we're using SASL and haven't completed auth, something went wrong
        // Complete authentication anyway to avoid being stuck
        if (this.state?.capNegotiation?.enabled) {
          console.log("Received 001 (RPL_WELCOME) but CAP negotiation still active, completing auth");
          if (!this.state.capNegotiation.saslAccepted) {
            // SASL wasn't completed, end CAP and complete normal authentication
            console.log("Ending CAP negotiation and completing authentication");
            this.sendIRC("CAP END");
            this.state.capNegotiation.enabled = false;
            this.completeAuthentication();
          }
        }
        return {
          id,
          timestamp,
          type: "notice",
          message: trailing,
          raw: line,
        };
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
          // Broadcast user list update
          this.broadcast({ 
            type: "userlist", 
            channel: channel,
            users: chan.users 
          });
        }
        return null;

      case "366": // RPL_ENDOFNAMES - end of user list
        // User list is complete, sort it
        const endChannel = paramParts[1];
        if (endChannel && this.state?.channels.has(endChannel)) {
          const chan = this.state.channels.get(endChannel)!;
          chan.users.sort();
          // Broadcast final user list
          this.broadcast({ 
            type: "userlist", 
            channel: endChannel,
            users: chan.users 
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
    // Exclude socket and other runtime-only objects that can't be cloned
    const { socket, capNegotiation, ...stateWithoutRuntime } = this.state;
    const stateToSave: any = {
      ...stateWithoutRuntime,
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

