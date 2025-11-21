import { Hono } from "hono";
import { IRCConnection } from "./irc-connection";

// Export the Durable Object class so Wrangler can register it
export { IRCConnection };

interface Env {
  IRC_CONNECTION: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

// API route to create/get IRC connection
app.post("/api/connect", async (c) => {
  const env = c.env;
  const body = await c.req.json() as {
    server: string;
    port: number;
    nick: string;
    username?: string;
    realname?: string;
    password?: string;
    connectionId?: string;
  };

  // Use provided connectionId or generate one
  // Use idFromName for deterministic IDs (same name = same Durable Object)
  const connectionId = body.connectionId || `${body.server}:${body.port}:${body.nick}`;
  console.log(`[API] Connect request for connectionId: ${connectionId}`);
  const id = env.IRC_CONNECTION.idFromName(connectionId);
  const stub = env.IRC_CONNECTION.get(id);

  try {
    const response = await stub.fetch(new Request("http://dummy/connect", {
      method: "POST",
      body: JSON.stringify(body),
    }));

    // Clone response to read it multiple times if needed
    const responseClone = response.clone();
    const responseText = await response.text();

    if (!response.ok) {
      return c.json({ 
        error: responseText || `HTTP ${response.status}` 
      }, response.status as any);
    }

    let responseData: Record<string, any>;
    try {
      responseData = JSON.parse(responseText) as Record<string, any>;
    } catch (e) {
      return c.json({ 
        error: "Invalid response from Durable Object",
        details: responseText.substring(0, 100)
      }, 500);
    }

    return c.json({
      connectionId,
      ...responseData,
    });
  } catch (error: any) {
    return c.json({ 
      error: error?.message || "Failed to connect to Durable Object",
      details: String(error)
    }, 500);
  }
});

app.post("/api/:connectionId/disconnect", async (c) => {
  const env = c.env;
  const connectionId = c.req.param("connectionId");
  if (!connectionId) {
    return c.text("Missing connectionId", 400);
  }
  const id = env.IRC_CONNECTION.idFromName(connectionId);
  const stub = env.IRC_CONNECTION.get(id);

  const response = await stub.fetch(new Request("http://dummy/disconnect", {
    method: "POST",
  }));

  return c.json(await response.json());
});

app.post("/api/:connectionId/send", async (c) => {
  const env = c.env;
  const connectionId = c.req.param("connectionId");
  if (!connectionId) {
    return c.text("Missing connectionId", 400);
  }
  const body = await c.req.json();
  const id = env.IRC_CONNECTION.idFromName(connectionId);
  const stub = env.IRC_CONNECTION.get(id);

  const response = await stub.fetch(new Request("http://dummy/send", {
    method: "POST",
    body: JSON.stringify(body),
  }));

  return c.json(await response.json());
});

app.get("/api/:connectionId/state", async (c) => {
  const env = c.env;
  const connectionId = c.req.param("connectionId");
  if (!connectionId) {
    return c.text("Missing connectionId", 400);
  }
  const id = env.IRC_CONNECTION.idFromName(connectionId);
  const stub = env.IRC_CONNECTION.get(id);

  const response = await stub.fetch(new Request("http://dummy/state", {
    method: "GET",
  }));

  return c.json(await response.json());
});

// Serve static files
app.get("*", async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  let pathname = url.pathname;

  // Default to index.html for root path
  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  }

  // Try to fetch from ASSETS binding
  try {
    const response = await env.ASSETS.fetch(new Request(new URL(pathname, c.req.url)));
    if (response.status === 200) {
      return response;
    }
    // If not found and it's a path that should serve index.html (SPA routing)
    if (response.status === 404 && !pathname.includes(".")) {
      const indexResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
      if (indexResponse.status === 200) {
        return indexResponse;
      }
    }
  } catch (e) {
    // Error fetching asset, continue to 404
  }

  return c.text("Not Found", 404);
});

// Export default handler that checks for WebSocket upgrades before routing
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle WebSocket upgrades BEFORE Hono routing
    // WebSocket upgrades must be forwarded directly to Durable Objects
    if (request.headers.get("Upgrade") === "websocket") {
      const pathParts = url.pathname.split('/');
      // Check if it's a WebSocket connection to a Durable Object
      if (pathParts[1] === "api" && pathParts[3] === "ws") {
        const connectionId = pathParts[2];
        console.log(`[API] WebSocket upgrade request for connectionId: ${connectionId}`);
        
        if (!connectionId) {
          return new Response("Missing connectionId", { status: 400 });
        }
        
        const id = env.IRC_CONNECTION.idFromName(connectionId);
        const stub = env.IRC_CONNECTION.get(id);
        
        // Forward the WebSocket upgrade request directly to the Durable Object
        return stub.fetch(request);
      }
    }
    
    // For all other requests, use Hono routing
    return app.fetch(request, env, ctx);
  },
};

