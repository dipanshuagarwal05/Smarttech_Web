import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const siteContext = await readFile(path.join(rootDir, "content.txt"), "utf8");
const keepAliveUrl = process.env.KEEPALIVE_URL || "https://smarttech-web.onrender.com";
const minKeepAliveDelayMs = 1 * 60 * 1000;
const maxKeepAliveDelayMs = 15 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function buildChatMessages(messages = []) {
  const filtered = Array.isArray(messages)
    ? messages
        .filter((message) => message && typeof message.role === "string" && typeof message.content === "string")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content.slice(0, 4000),
        }))
    : [];

  return [
    {
      role: "system",
      content: `${siteContext}\n\nAnswer the user using the company details above. Keep the reply formal, clear, and plain text only. Do not use markdown.`,
    },
    ...filtered,
  ];
}

function scheduleKeepAlivePing() {
  const delay = Math.floor(
    minKeepAliveDelayMs + Math.random() * (maxKeepAliveDelayMs - minKeepAliveDelayMs)
  );

  setTimeout(() => {
    const target = new URL(keepAliveUrl);
    const transport = target.protocol === "https:" ? https : http;

    const request = transport.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        headers: {
          "Cache-Control": "no-store",
          "User-Agent": "SmartTech-KeepAlive/1.0",
        },
      },
      (response) => {
        response.resume();
        console.log(`[keepalive] ${new Date().toISOString()} ${response.statusCode} ${keepAliveUrl}`);
      }
    );

    request.on("error", (error) => {
      console.warn(`[keepalive] ${new Date().toISOString()} ${error.message}`);
    });

    request.end();
    scheduleKeepAlivePing();
  }, delay);
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(rootDir, pathname));
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      const indexContent = await readFile(indexPath);
      const indexExt = path.extname(indexPath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[indexExt] || "application/octet-stream" });
      res.end(indexContent);
      return;
    }

    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/chat" && req.method === "POST") {
    try {
      const body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 1_000_000) {
            reject(new Error("Payload too large"));
            req.destroy();
          }
        });
        req.on("end", () => resolve(raw));
        req.on("error", reject);
      });

      const payload = body ? JSON.parse(body) : {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];

      if (!process.env.GROQ_API_KEY) {
        sendJson(res, 500, { error: "Missing GROQ_API_KEY." });
        return;
      }

      const completion = await client.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: buildChatMessages(messages),
        temperature: 0.4,
        max_completion_tokens: 900,
      });

      const reply = completion.choices?.[0]?.message?.content?.trim() || "I could not generate a response.";
      sendJson(res, 200, { reply });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Failed to generate response.",
      });
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`SmartTech site running at http://localhost:${port}`);
  scheduleKeepAlivePing();
});
