class IRCClient {
  constructor() {
    this.connectionId = null;
    this.ws = null;
    this.currentChannel = null;
    this.channels = new Map();
    this.connections = new Map();
    this.serverLog = []; // Store server log messages
    this.nickname = null; // Store current nickname
    this.pendingChannelHistory = new Set(); // Track channels we're waiting for history
    this.receivedChannelHistory = new Set(); // Track channels we've received history for
    
    this.init();
  }

  init() {
    // Load saved form values from sessionStorage
    this.loadFormValues();
    
    // Load saved connections from localStorage
    this.loadConnections();
    
    // Try to restore previous connection
    this.restoreConnection();
    
    // Event listeners
    document.getElementById('newConnectionBtn').addEventListener('click', () => {
      this.toggleConnectionForm();
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      this.toggleConnectionForm();
    });

    document.getElementById('connectBtn').addEventListener('click', () => {
      this.connect();
    });

    // Server dropdown handler
    const serverSelect = document.getElementById('serverSelect');
    const serverInput = document.getElementById('serverInput');
    serverSelect.addEventListener('change', (e) => {
      const value = e.target.value;
      if (value && value !== 'custom') {
        serverInput.value = value;
        // Set default port for known servers
        if (value === 'irc.libera.chat' || value === 'irc.freenode.net') {
          document.getElementById('portInput').value = '6697';
        }
        serverInput.style.display = 'none';
        this.saveFormValues();
      } else if (value === 'custom') {
        serverInput.value = '';
        serverInput.style.display = 'block';
        serverInput.focus();
      } else {
        serverInput.style.display = 'block';
      }
    });

    // Show server input initially if no saved value
    if (!serverInput.value) {
      serverInput.style.display = 'block';
    } else {
      serverInput.style.display = 'none';
    }

    // Save form values on input change
    const formInputs = ['serverInput', 'portInput', 'nickInput', 'usernameInput', 'realnameInput'];
    formInputs.forEach(id => {
      const input = document.getElementById(id);
      input.addEventListener('input', () => {
        this.saveFormValues();
      });
    });

    document.getElementById('sendBtn').addEventListener('click', () => {
      this.sendMessage();
    });

    const messageInput = document.getElementById('messageInput');
    messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.sendMessage();
      }
    });

    // Handle IRC commands
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        // Allow multiline
        return;
      }
    });
  }

  toggleConnectionForm() {
    const form = document.getElementById('connectionForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }

  async connect() {
    const server = document.getElementById('serverInput').value;
    const port = parseInt(document.getElementById('portInput').value) || 6697;
    const nick = document.getElementById('nickInput').value;
    const username = document.getElementById('usernameInput').value || nick;
    const realname = document.getElementById('realnameInput').value || nick;
    const password = document.getElementById('passwordInput').value;

    if (!server || !nick) {
      alert('Server and Nickname are required');
      return;
    }

    // Save form values before connecting
    this.saveFormValues();

    try {
      const response = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server,
          port,
          nick,
          username,
          realname,
          password: password || undefined,
        }),
      });

      // Clone the response to read it multiple times if needed
      const responseClone = response.clone();
      
      let data;
      try {
        data = await response.json();
      } catch (e) {
        // If JSON parsing fails, try to read as text from the clone
        const text = await responseClone.text();
        throw new Error(`Server returned invalid JSON: ${text.substring(0, 100)}`);
      }

      if (!response.ok || data.error) {
        throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      this.connectionId = data.connectionId;
      // Store nickname from form
      this.nickname = nick;

      // Save connection info to localStorage for persistence
      this.saveConnection({
        connectionId: data.connectionId,
        server,
        port,
        nick,
        username,
        realname,
      });

      // Ensure server log tab exists
      this.ensureServerLogTab();

      // Switch to server log to show connection status
      this.selectChannel('__SERVER_LOG__');

      // Connect WebSocket FIRST and wait for it to actually connect
      await new Promise((resolve) => {
        this.connectWebSocket();
        
        // Wait for WebSocket to open
        const checkConnection = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            console.log('WebSocket ready, IRC connection will start');
            resolve();
          }
        }, 50);

        // Timeout after 2 seconds
        setTimeout(() => {
          clearInterval(checkConnection);
          console.warn('WebSocket connection timeout, proceeding anyway');
          resolve(); // Proceed anyway
        }, 2000);
      });

      // Add to connections list
      this.addConnectionToList(server, port, nick, this.connectionId);

      // Hide form but keep values in sessionStorage
      this.toggleConnectionForm();
      // Don't clear form - keep values for next connection

      // Enable input
      document.getElementById('messageInput').disabled = false;
      document.getElementById('sendBtn').disabled = false;
    } catch (error) {
      console.error('Connection error:', error);
      alert('Failed to connect: ' + (error.message || String(error)));
    }
  }

  connectWebSocket() {
    if (!this.connectionId) return;

    // Ensure server log tab exists before connecting
    this.ensureServerLogTab();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/${this.connectionId}/ws`;
    
    console.log('Connecting WebSocket to:', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected successfully');
      // Switch to server log when WebSocket connects
      if (!this.currentChannel || this.currentChannel === '__SERVER_LOG__') {
        this.selectChannel('__SERVER_LOG__');
      }
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleWebSocketMessage(data);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      setTimeout(() => {
        if (this.connectionId) {
          this.connectWebSocket();
        }
      }, 3000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleWebSocketMessage(data) {
    const messagePreview = typeof data.message === 'string' ? data.message.substring(0, 50) : (data.message || '');
    console.log('WebSocket message received:', data.type, messagePreview);
    switch (data.type) {
      case 'state':
        this.updateState(data.state);
        break;
      case 'status':
        this.addServerLog(data.message || 'Status update', 'status');
        break;
      case 'connected':
        this.addServerLog('Connected to IRC server', 'status');
        break;
      case 'disconnected':
        this.addServerLog('Disconnected from IRC server', 'status');
        break;
      case 'raw':
        // Raw IRC protocol message
        console.log('Adding raw message to server log:', data.message);
        this.addServerLog(data.message || '', 'raw');
        break;
      case 'message':
        this.handleIRCMessage(data.message);
        break;
      case 'channel_history':
        // Restore channel message history
        if (data.channel && data.messages && Array.isArray(data.messages)) {
          if (!this.channels.has(data.channel)) {
            this.channels.set(data.channel, []);
            this.addChannelToList(data.channel);
          }
          // Add all messages to the channel
          const channelMessages = this.channels.get(data.channel);
          // Clear existing messages and restore from history
          channelMessages.length = 0;
          data.messages.forEach(msg => {
            // Filter out empty messages
            if (msg.message && msg.message.trim()) {
              channelMessages.push(msg);
            }
          });
          
          // Track that we received history for this channel
          if (this.receivedChannelHistory) {
            this.receivedChannelHistory.add(data.channel);
          }
          
          // If this channel is currently selected, refresh the display
          if (this.currentChannel === data.channel) {
            this.loadChannelMessages(data.channel);
          }
          console.log(`Restored ${data.messages.length} messages for channel ${data.channel}`);
        }
        break;
      case 'error':
        this.addServerLog(`Error: ${data.error}`, 'error');
        console.error('IRC error:', data.error);
        break;
      default:
        console.log('Unknown message type:', data.type, data);
    }
  }

  handleIRCMessage(msg) {
    // Always log raw IRC messages to server log
    if (msg.raw) {
      this.addServerLog(msg.raw, 'raw');
    }

    if (msg.type === 'message' && msg.channel) {
      // Channel message - filter out empty messages
      if (!msg.message || !msg.message.trim()) {
        return;
      }
      
      if (!this.channels.has(msg.channel)) {
        this.channels.set(msg.channel, []);
        this.addChannelToList(msg.channel);
      }
      
      // Check for duplicates before adding
      const channelMessages = this.channels.get(msg.channel);
      const isDuplicate = channelMessages.some(existingMsg => 
        existingMsg.id === msg.id || 
        (existingMsg.user === msg.user &&
         existingMsg.message === msg.message &&
         Math.abs(existingMsg.timestamp - msg.timestamp) < 2000)
      );
      
      if (!isDuplicate) {
        channelMessages.push(msg);
        
        if (this.currentChannel === msg.channel) {
          this.displayMessage(msg);
        }
      }
    } else if (msg.type === 'join' && msg.channel) {
      // User joined channel
      if (!this.channels.has(msg.channel)) {
        this.channels.set(msg.channel, []);
        this.addChannelToList(msg.channel);
      }
      // Show in channel if we're viewing it, otherwise just log
      if (this.currentChannel === msg.channel) {
        this.showMessage(`${msg.user} joined ${msg.channel}`, 'system');
      }
    } else if (msg.type === 'part' && msg.channel) {
      // User left channel
      if (this.currentChannel === msg.channel) {
        this.showMessage(`${msg.user} left ${msg.channel}`, 'system');
      }
    } else if (msg.type === 'nick') {
      // Nickname change - update our nickname if it's us
      if (msg.user === this.nickname && msg.message) {
        this.nickname = msg.message;
      }
      // Show in current channel if we're viewing it
      if (this.currentChannel && this.currentChannel !== '__SERVER_LOG__') {
        this.showMessage(`${msg.user} is now known as ${msg.message}`, 'system');
      }
    } else if (msg.type === 'notice') {
      // Notice message - show in server log
      this.addServerLog(msg.message || msg.raw || '', 'notice');
    } else {
      // Other messages (server messages, etc.) - show in server log
      this.addServerLog(msg.message || msg.raw || '', 'system');
    }
  }

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (!message || !this.connectionId) return;

    // Handle IRC commands
    if (message.startsWith('/')) {
      await this.handleCommand(message);
    } else if (this.currentChannel) {
      // Backend handles optimistic messages now, so we don't need to add them here
      // The backend will broadcast the message when it's saved
      
      // Send to server
      await fetch(`/api/${this.connectionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: this.currentChannel,
          message,
        }),
      });
    }

    input.value = '';
  }

  async handleCommand(command) {
    const parts = command.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'join':
        if (parts[1]) {
          await fetch(`/api/${this.connectionId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `JOIN ${parts[1]}` }),
          });
        }
        break;
      case 'part':
        if (parts[1]) {
          await fetch(`/api/${this.connectionId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `PART ${parts[1]}` }),
          });
        }
        break;
      case 'nick':
        if (parts[1]) {
          await fetch(`/api/${this.connectionId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `NICK ${parts[1]}` }),
          });
        }
        break;
      case 'msg':
      case 'privmsg':
        if (parts[1] && parts[2]) {
          await fetch(`/api/${this.connectionId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: parts[1],
              message: parts.slice(2).join(' '),
            }),
          });
        }
        break;
      default:
        // Send raw IRC command
        await fetch(`/api/${this.connectionId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: command.slice(1) }),
        });
    }
  }

  displayMessage(msg) {
    const container = document.getElementById('messagesContainer');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${msg.type}`;

    const time = new Date(msg.timestamp).toLocaleTimeString();
    
    if (msg.user) {
      messageEl.innerHTML = `
        <div class="message-header">
          <span class="message-user">${this.escapeHtml(msg.user)}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${this.escapeHtml(msg.message || '')}</div>
      `;
    } else {
      messageEl.innerHTML = `
        <div class="message-content">${this.escapeHtml(msg.message || msg.raw || '')}</div>
      `;
    }

    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
  }

  showMessage(text, type = 'system') {
    // Only show in current channel if it's not server log
    if (this.currentChannel === '__SERVER_LOG__') {
      this.addServerLog(text, type);
      return;
    }

    const container = document.getElementById('messagesContainer');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;
    
    const time = new Date().toLocaleTimeString();
    messageEl.innerHTML = `
      <div class="message-header">
        <span class="message-time">${time}</span>
      </div>
      <div class="message-content">${this.escapeHtml(text)}</div>
    `;

    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
  }

  addChannelToList(channel) {
    // Check if channel already exists
    const existing = document.querySelector(`.channel-item[data-channel="${channel}"]`);
    if (existing) return;

    const channelList = document.getElementById('channelList');
    const channelEl = document.createElement('div');
    channelEl.className = 'channel-item';
    channelEl.dataset.channel = channel;
    channelEl.innerHTML = `
      <span class="channel-name">${this.escapeHtml(channel)}</span>
      <span class="channel-badge">0</span>
    `;
    
    channelEl.addEventListener('click', () => {
      this.selectChannel(channel);
    });

    channelList.appendChild(channelEl);
  }

  ensureServerLogTab() {
    const channelList = document.getElementById('channelList');
    const existing = document.querySelector('.channel-item[data-channel="__SERVER_LOG__"]');
    if (!existing) {
      const serverLogEl = document.createElement('div');
      serverLogEl.className = 'channel-item';
      serverLogEl.dataset.channel = '__SERVER_LOG__';
      serverLogEl.innerHTML = `
        <span class="channel-name">Server Log</span>
        <span class="channel-badge server-log-badge">0</span>
      `;
      
      serverLogEl.addEventListener('click', () => {
        this.selectChannel('__SERVER_LOG__');
      });

      // Insert at the beginning
      channelList.insertBefore(serverLogEl, channelList.firstChild);
    }
  }

  addServerLog(message, type = 'status') {
    if (!message) return;
    
    // Ensure server log tab exists
    this.ensureServerLogTab();
    
    this.serverLog.push({
      timestamp: Date.now(),
      message,
      type
    });

    // Keep only last 1000 log entries
    if (this.serverLog.length > 1000) {
      this.serverLog.shift();
    }

    // Update badge
    const badge = document.querySelector('.channel-item[data-channel="__SERVER_LOG__"] .channel-badge');
    if (badge) {
      badge.textContent = this.serverLog.length;
    }

    // If server log is currently selected, display the message
    if (this.currentChannel === '__SERVER_LOG__') {
      this.displayServerLogMessage(message, type);
    } else {
      // Log to console for debugging
      console.log(`[Server Log ${type}]:`, message);
    }
  }

  selectChannel(channel) {
    this.currentChannel = channel;
    
    // Save last viewed channel
    localStorage.setItem('ircLastChannel', channel);
    
    // Update UI
    if (channel === '__SERVER_LOG__') {
      document.getElementById('currentChannel').textContent = 'Server Log';
      document.getElementById('channelInfo').textContent = 'IRC protocol messages and connection status';
      document.getElementById('messageInput').disabled = true;
      document.getElementById('sendBtn').disabled = true;
    } else {
      document.getElementById('currentChannel').textContent = channel;
      document.getElementById('channelInfo').textContent = '';
      document.getElementById('messageInput').disabled = false;
      document.getElementById('sendBtn').disabled = false;
    }
    
    // Update active channel
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.remove('active');
      if (item.dataset.channel === channel) {
        item.classList.add('active');
      }
    });

    // Load messages for this channel
    if (channel === '__SERVER_LOG__') {
      this.loadServerLog();
    } else {
      this.loadChannelMessages(channel);
    }
  }

  loadChannelMessages(channel) {
    const container = document.getElementById('messagesContainer');
    container.innerHTML = '';

    if (this.channels.has(channel)) {
      const messages = this.channels.get(channel);
      messages.forEach(msg => this.displayMessage(msg));
    }
  }

  loadServerLog() {
    const container = document.getElementById('messagesContainer');
    container.innerHTML = '';

    this.serverLog.forEach(log => {
      this.displayServerLogMessage(log.message, log.type);
    });
  }

  displayServerLogMessage(message, type = 'status') {
    const container = document.getElementById('messagesContainer');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type} server-log-message`;
    
    const time = new Date().toLocaleTimeString();
    // Raw messages already have → or ← prefix from backend
    const displayMessage = type === 'raw' ? message : message;
    
    messageEl.innerHTML = `
      <div class="message-header">
        <span class="message-time">${time}</span>
        ${type === 'raw' ? '<span class="log-type">RAW</span>' : ''}
      </div>
      <div class="message-content">${this.escapeHtml(displayMessage)}</div>
    `;

    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
  }

  addConnectionToList(server, port, nick, connectionId = null) {
    const connectionsList = document.getElementById('connectionsList');
    
    // Check if connection already exists
    const existing = Array.from(connectionsList.children).find(el => {
      const nameEl = el.querySelector('.connection-name');
      return nameEl && nameEl.textContent === server;
    });
    
    if (existing) {
      // Update existing connection
      const statusEl = existing.querySelector('.connection-status');
      if (statusEl) {
        statusEl.textContent = 'Connected';
        statusEl.className = 'connection-status connected';
      }
      // Update active state
      const connectionsList = document.getElementById('connectionsList');
      Array.from(connectionsList.children).forEach(el => {
        el.classList.remove('active');
      });
      existing.classList.add('active');
      return;
    }
    
    const connectionEl = document.createElement('div');
    connectionEl.className = 'connection-item active';
    if (connectionId) {
      connectionEl.dataset.connectionId = connectionId;
    }
    connectionEl.innerHTML = `
      <div class="connection-name">${this.escapeHtml(server)}</div>
      <div class="connection-status connected">Connected</div>
    `;
    
    // Update active state - only one connection should be active
    Array.from(connectionsList.children).forEach(el => {
      el.classList.remove('active');
    });
    
    // Add click handler to switch to this connection
    if (connectionId) {
      connectionEl.addEventListener('click', () => {
        if (connectionId !== this.connectionId) {
          // Switch to this connection
          this.switchConnection(connectionId);
        }
      });
    }
    
    connectionsList.appendChild(connectionEl);
  }

  async switchConnection(connectionId) {
    // Close current WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clear current state
    this.channels.clear();
    const channelList = document.getElementById('channelList');
    channelList.innerHTML = '';
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    // Update active connection in sidebar
    const connectionsList = document.getElementById('connectionsList');
    Array.from(connectionsList.children).forEach(el => {
      el.classList.remove('active');
      if (el.dataset.connectionId === connectionId) {
        el.classList.add('active');
      }
    });

    // Load and restore the connection
    const saved = localStorage.getItem('ircCurrentConnection');
    if (saved) {
      const connectionInfo = JSON.parse(saved);
      if (connectionInfo.connectionId === connectionId) {
        // Restore this connection
        await this.restoreConnection();
      }
    }
  }

  updateState(state) {
    if (!state) return;

    // Update nickname from state if available
    if (state.nick) {
      this.nickname = state.nick;
    }

    // Update channels
    if (state.channels) {
      state.channels.forEach(channel => {
        if (!this.channels.has(channel.name)) {
          this.channels.set(channel.name, []);
          this.addChannelToList(channel.name);
        }
      });
    }
  }

  saveFormValues() {
    const formData = {
      server: document.getElementById('serverInput').value,
      port: document.getElementById('portInput').value,
      nick: document.getElementById('nickInput').value,
      username: document.getElementById('usernameInput').value,
      realname: document.getElementById('realnameInput').value,
    };
    sessionStorage.setItem('ircFormValues', JSON.stringify(formData));
  }

  loadFormValues() {
    try {
      const saved = sessionStorage.getItem('ircFormValues');
      if (saved) {
        const formData = JSON.parse(saved);
        if (formData.server) {
          const serverInput = document.getElementById('serverInput');
          serverInput.value = formData.server;
          // Set dropdown if it matches a known server
          const serverSelect = document.getElementById('serverSelect');
          const option = Array.from(serverSelect.options).find(opt => opt.value === formData.server);
          if (option) {
            serverSelect.value = formData.server;
            serverInput.style.display = 'none';
          } else {
            serverSelect.value = 'custom';
            serverInput.style.display = 'block';
          }
        }
        if (formData.port) {
          document.getElementById('portInput').value = formData.port;
        }
        if (formData.nick) {
          document.getElementById('nickInput').value = formData.nick;
        }
        if (formData.username) {
          document.getElementById('usernameInput').value = formData.username;
        }
        if (formData.realname) {
          document.getElementById('realnameInput').value = formData.realname;
        }
      }
    } catch (e) {
      console.error('Failed to load form values:', e);
    }
  }

  clearForm() {
    document.getElementById('serverSelect').value = '';
    document.getElementById('serverInput').value = '';
    document.getElementById('portInput').value = '6697';
    document.getElementById('nickInput').value = '';
    document.getElementById('usernameInput').value = '';
    document.getElementById('realnameInput').value = '';
    document.getElementById('passwordInput').value = '';
    sessionStorage.removeItem('ircFormValues');
  }

  loadConnections() {
    // Load from localStorage if needed
    const saved = localStorage.getItem('ircConnections');
    if (saved) {
      try {
        const connections = JSON.parse(saved);
        // Restore connections
      } catch (e) {
        console.error('Failed to load connections:', e);
      }
    }
  }

  saveConnection(connectionInfo) {
    localStorage.setItem('ircCurrentConnection', JSON.stringify(connectionInfo));
  }

  async restoreConnection() {
    try {
      const saved = localStorage.getItem('ircCurrentConnection');
      if (!saved) return;

      const connectionInfo = JSON.parse(saved);
      this.connectionId = connectionInfo.connectionId;
      this.nickname = connectionInfo.nick;

      console.log('Restoring connection:', connectionInfo.connectionId);

      // Fetch current state from Durable Object
      const stateResponse = await fetch(`/api/${this.connectionId}/state`);
      if (!stateResponse.ok) {
        console.warn('Failed to fetch state, connection may not exist');
        localStorage.removeItem('ircCurrentConnection');
        return;
      }

      const state = await stateResponse.json();
      // Don't require connected state - the connection might be temporarily disconnected
      // but we should still restore channels and messages
      if (!state) {
        console.log('No state found, clearing saved connection');
        localStorage.removeItem('ircCurrentConnection');
        return;
      }
      
      // If not connected, we'll reconnect when WebSocket connects
      if (!state.connected) {
        console.log('IRC connection not active, will reconnect when WebSocket connects');
      }

      // Restore nickname
      if (state.nick) {
        this.nickname = state.nick;
      }

      // Add connection to sidebar
      this.addConnectionToList(connectionInfo.server, connectionInfo.port, connectionInfo.nick, connectionInfo.connectionId);

      // Track which channels we're expecting history for
      const expectedChannels = new Set();
      if (state.channels && state.channels.length > 0) {
        state.channels.forEach(channel => {
          expectedChannels.add(channel.name);
          if (!this.channels.has(channel.name)) {
            this.channels.set(channel.name, []);
          }
          this.addChannelToList(channel.name);
        });
      }

      // Ensure server log tab exists
      this.ensureServerLogTab();

      // Track which channels we're expecting history for
      this.pendingChannelHistory = new Set(expectedChannels);
      this.receivedChannelHistory = new Set();

      // Connect WebSocket to restore real-time updates and buffered messages
      await new Promise((resolve) => {
        this.connectWebSocket();
        
        // Wait for WebSocket to open
        const checkConnection = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            console.log('WebSocket reconnected, waiting for channel history...');
            
            // Wait for all channel history to arrive
            const checkHistory = setInterval(() => {
              if (this.receivedChannelHistory.size >= this.pendingChannelHistory.size) {
                clearInterval(checkHistory);
                console.log('All channel history received');
                resolve();
              }
            }, 100);
            
            // Timeout after 5 seconds - proceed anyway
            setTimeout(() => {
              clearInterval(checkHistory);
              console.warn(`Channel history timeout: received ${this.receivedChannelHistory.size}/${this.pendingChannelHistory.size}`);
              resolve();
            }, 5000);
          }
        }, 50);

        // Timeout after 2 seconds for WebSocket connection
        setTimeout(() => {
          clearInterval(checkConnection);
          console.warn('WebSocket reconnection timeout');
          resolve();
        }, 2000);
      });

      // Restore last viewed channel or default to server log
      const lastChannel = localStorage.getItem('ircLastChannel') || '__SERVER_LOG__';
      this.selectChannel(lastChannel);

      // Enable input
      document.getElementById('messageInput').disabled = false;
      document.getElementById('sendBtn').disabled = false;

      // Hide connection form
      document.getElementById('connectionForm').style.display = 'none';

      console.log('Connection restored successfully');
    } catch (error) {
      console.error('Failed to restore connection:', error);
      localStorage.removeItem('ircCurrentConnection');
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app
const app = new IRCClient();

