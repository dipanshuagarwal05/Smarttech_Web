import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import nodemailer from "nodemailer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});
const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
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

function normalizeText(value, limit = 2000) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function readRequestBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readRequestBody(req, maxBytes) {
  const buffer = await readRequestBodyBuffer(req, maxBytes);
  return buffer.toString("utf8");
}

async function sendEnquiryEmail(payload) {
  const name = normalizeText(payload.name, 120);
  const email = normalizeText(payload.email, 160);
  const mobile = normalizeText(payload.mobile, 40);
  const message = normalizeText(payload.message, 4000);

  if (!name || !email || !mobile || !message) {
    throw new Error("All enquiry fields are required.");
  }

  const recipient = process.env.ENQUIRY_TO || process.env.GMAIL_USER;
  if (!recipient) {
    throw new Error("Missing mail recipient configuration.");
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMobile = escapeHtml(mobile);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br>");

  return mailTransporter.sendMail({
    from: process.env.GMAIL_USER,
    to: recipient,
    subject: `Enquiry from ${name}`,
    text: `Email: ${email}\n\nMobile: ${mobile}\n\nName: ${name}\n\nBodyy: ${message}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #243229; line-height: 1.7;">
        <p><strong>FROM:</strong> ${safeEmail} ( ${safeName} ) <br><strong>MOBILE:</strong> ${safeMobile}</p>
        <p><strong>ENQUIRY:</strong><br>${safeMessage}</p>
      </div>
    `,
  });
}

function queueEnquiryEmail(payload) {
  setImmediate(async () => {
    try {
      await sendEnquiryEmail(payload);
      console.log(`[enquiry] ${new Date().toISOString()} Email sent successfully`);
    } catch (error) {
      console.error(
        `[enquiry] ${new Date().toISOString()} Email failed:`,
        error instanceof Error ? error.message : error
      );
    }
  });
}

// ---------- Order form email logic ----------
function normalizeOrderText(value, limit = 2000) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ORDER_BODY_MAX_BYTES = 40 * 1024 * 1024;

function parseMultipartHeaders(headerBlock) {
  const headers = {};
  const lines = headerBlock.split("\r\n");

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function parseMultipartFormData(bodyBuffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);

  if (!boundary) {
    throw new Error("Missing multipart boundary.");
  }

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerDelimiter = Buffer.from("\r\n\r\n");
  const fields = {};
  const attachment = null;
  let cursor = bodyBuffer.indexOf(boundaryBuffer);

  if (cursor === -1) {
    throw new Error("Malformed multipart body.");
  }

  while (cursor !== -1) {
    cursor += boundaryBuffer.length;

    if (bodyBuffer[cursor] === 45 && bodyBuffer[cursor + 1] === 45) {
      break;
    }

    if (bodyBuffer[cursor] === 13 && bodyBuffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextBoundary = bodyBuffer.indexOf(boundaryBuffer, cursor);
    if (nextBoundary === -1) {
      break;
    }

    let partEnd = nextBoundary;
    if (bodyBuffer[partEnd - 2] === 13 && bodyBuffer[partEnd - 1] === 10) {
      partEnd -= 2;
    }

    const part = bodyBuffer.slice(cursor, partEnd);
    const headerEnd = part.indexOf(headerDelimiter);
    if (headerEnd !== -1) {
      const headerBlock = part.slice(0, headerEnd).toString("utf8");
      const content = part.slice(headerEnd + headerDelimiter.length);
      const headers = parseMultipartHeaders(headerBlock);
      const disposition = headers["content-disposition"] || "";
      const nameMatch = /name="([^"]+)"/i.exec(disposition);
      const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
      const fieldName = nameMatch ? nameMatch[1] : "";

      if (fieldName) {
        if (filenameMatch && filenameMatch[1]) {
          fields[fieldName] = {
            name: filenameMatch[1],
            type: headers["content-type"] || "application/octet-stream",
            size: content.length,
            content,
          };
        } else {
          fields[fieldName] = content.toString("utf8");
        }
      }
    }

    cursor = nextBoundary;
  }

  return fields;
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const name = normalizeOrderText(attachment.name, 180);
  const type = normalizeOrderText(attachment.type, 120) || "application/octet-stream";
  const rawContent = attachment.content;
  const size = Number(attachment.size);

  let buffer = null;
  if (Buffer.isBuffer(rawContent)) {
    buffer = rawContent;
  } else if (typeof rawContent === "string" && rawContent.trim()) {
    buffer = Buffer.from(rawContent.trim(), "base64");
  }

  if (!name || !buffer || buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("Invalid attachment supplied.");
  }

  if (Number.isFinite(size) && size > 0 && size !== buffer.length) {
    throw new Error("Attachment data is corrupted or incomplete.");
  }

  return {
    filename: name,
    content: buffer,
    contentType: type,
  };
}

async function sendOrderEmail(payload) {
  const repName = normalizeOrderText(payload.representative_name, 120);
  const orderFor = normalizeOrderText(payload.order_for, 250);
  const date = normalizeOrderText(payload.date, 40);
  const remark = normalizeOrderText(payload.remark, 2000);
  const email = normalizeOrderText(payload.email, 160);
  const phone = normalizeOrderText(payload.phone, 40);

  if (!repName || !orderFor || !date || !remark || !email || !phone) {
    throw new Error("All order fields are required.");
  }

  const attachment = normalizeAttachment(payload.attachment);

  const recipient = process.env.ORDER_TO || process.env.ENQUIRY_TO || process.env.GMAIL_USER;
  if (!recipient) {
    throw new Error("Missing mail recipient configuration.");
  }

  const safeRepName = escapeHtml(repName);
  const safeOrderFor = escapeHtml(orderFor);
  const safeDate = escapeHtml(date);
  const safeRemark = escapeHtml(remark).replaceAll("\n", "<br>");
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);

  return mailTransporter.sendMail({
    from: process.env.GMAIL_USER,
    to: recipient,
    subject: `New Order from ${repName}`,
    text: `Representative: ${repName}\nOrder For: ${orderFor}\nDate: ${date}\nPhone: ${phone}\nEmail: ${email}${attachment ? `\nAttachment: ${attachment.filename}` : ""}\n\nRemark:\n${remark}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #243229; line-height: 1.7;">
        <h2 style="color:#0f381c;">New Order Received</h2>
        <p><strong>Representative:</strong> ${safeRepName}</p>
        <p><strong>Order For:</strong> ${safeOrderFor}</p>
        <p><strong>Date:</strong> ${safeDate}</p>
        <p><strong>Phone:</strong> ${safePhone}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <hr>
        <p><strong>Remark:</strong><br>${safeRemark}</p>
        ${
          attachment
            ? `<p><strong>Attachment:</strong> ${escapeHtml(attachment.filename)}</p>`
            : ""
        }
      </div>
    `,
    attachments: attachment ? [attachment] : undefined,
  });
}

function queueOrderEmail(payload) {
  setImmediate(async () => {
    try {
      await sendOrderEmail(payload);
      console.log(`[order] ${new Date().toISOString()} Order email sent`);
    } catch (error) {
      console.error(
        `[order] ${new Date().toISOString()} Email failed:`,
        error instanceof Error ? error.message : error
      );
    }
  });
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
      const body = await readRequestBody(req, 1_000_000);

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

  if (requestUrl.pathname === "/api/enquiry" && req.method === "POST") {
    try {
      const body = await readRequestBody(req, 1_000_000);

      const payload = body ? JSON.parse(body) : {};
      sendJson(res, 200, { success: true, message: "Enquiry sent successfully." });
      queueEnquiryEmail(payload);
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send enquiry.",
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/order" && req.method === "POST") {
    try {
      const contentType = String(req.headers["content-type"] || "");
      let payload = {};

      if (contentType.includes("multipart/form-data")) {
        const body = await readRequestBodyBuffer(req, ORDER_BODY_MAX_BYTES);
        payload = parseMultipartFormData(body, contentType);
      } else {
        const body = await readRequestBody(req, ORDER_BODY_MAX_BYTES);
        payload = body ? JSON.parse(body) : {};
      }

      sendJson(res, 200, { success: true, message: "Order submitted successfully." });
      queueOrderEmail(payload);
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : "Failed to submit order.",
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
