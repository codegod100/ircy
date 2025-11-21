class IRCClient {
  constructor() {
    this.connectionId = null;
    this.ws = null;
    this.currentChannel = null;
    this.channels = new Map();
    this.connections = new Map();
    this.serverLog = []; // Store server log messages
    this.nickname = null; // Store current nickname
    
    this.init();
  }

  init() {
    // Load saved form values from sessionStorage
    this.loadFormValues();
    
    // Load saved connections from localStorage
    this.loadConnections();
    
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
      this.addConnectionToList(server, port, nick);

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
      // Channel message
      if (!this.channels.has(msg.channel)) {
        this.channels.set(msg.channel, []);
        this.addChannelToList(msg.channel);
      }
      this.channels.get(msg.channel).push(msg);
      
      if (this.currentChannel === msg.channel) {
        this.displayMessage(msg);
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
      // Optimistically display the message immediately
      if (this.currentChannel !== '__SERVER_LOG__') {
        const optimisticMsg = {
          id: `optimistic-${Date.now()}`,
          timestamp: Date.now(),
          type: 'message',
          channel: this.currentChannel,
          user: this.nickname,
          message: message,
        };
        
        // Add to channel messages
        if (!this.channels.has(this.currentChannel)) {
          this.channels.set(this.currentChannel, []);
        }
        this.channels.get(this.currentChannel).push(optimisticMsg);
        
        // Display immediately
        this.displayMessage(optimisticMsg);
      }
      
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

  addConnectionToList(server, port, nick) {
    const connectionsList = document.getElementById('connectionsList');
    const connectionEl = document.createElement('div');
    connectionEl.className = 'connection-item active';
    connectionEl.innerHTML = `
      <div class="connection-name">${this.escapeHtml(server)}</div>
      <div class="connection-status connected">Connected</div>
    `;
    
    connectionsList.appendChild(connectionEl);
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

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app
const app = new IRCClient();

