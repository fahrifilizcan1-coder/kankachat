const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { WebSocketServer, WebSocket } = require("ws");
const Busboy = require("busboy");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === "true";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const SESSION_COOKIE = "kanka_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOADS = new Map([
  [".png", { mimeTypes: ["image/png"], isImage: true }],
  [".jpg", { mimeTypes: ["image/jpeg", "image/jpg"], isImage: true }],
  [".jpeg", { mimeTypes: ["image/jpeg", "image/jpg"], isImage: true }],
  [".gif", { mimeTypes: ["image/gif"], isImage: true }],
  [".pdf", { mimeTypes: ["application/pdf"], isImage: false }],
  [".docx", {
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
      "application/octet-stream",
    ],
    isImage: false,
  }],
  [".txt", { mimeTypes: ["text/plain"], isImage: false }],
  [".zip", {
    mimeTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    isImage: false,
  }],
]);
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);

const sessions = new Map();
const eventClients = new Map();
const voiceRooms = new Map();
let saveTimer = null;
let state = loadState();

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    return { users: [], rooms: [], messages: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      users: Array.isArray(parsed.users) ? parsed.users.map(normalizeUser) : [],
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch (error) {
    console.error("Veri dosyasi okunamadi, bos durumla baslatiliyor:", error.message);
    return { users: [], rooms: [], messages: [] };
  }
}

function normalizeUser(user) {
  return {
    ...user,
    displayName: String(user.displayName || user.name || "Yeni Kanka").slice(0, 40),
    bio: String(user.bio || "").slice(0, 160),
    statusMessage: String(user.statusMessage || "").slice(0, 60),
    theme: user.theme === "light" ? "light" : "dark",
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const temporaryFile = `${STATE_FILE}.tmp`;
    fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8", (error) => {
      if (error) {
        console.error("Veriler kaydedilemedi:", error.message);
        return;
      }
      fs.rename(temporaryFile, STATE_FILE, (renameError) => {
        if (renameError) console.error("Veri dosyasi yenilenemedi:", renameError.message);
      });
    });
  }, 100);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Istek cok buyuk."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Gecersiz JSON."));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const cookies = {};
  for (const pair of (req.headers.cookie || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = state.users.find((entry) => (
    session.googleSub
      ? entry.googleSub === session.googleSub
      : entry.id === session.userId
  ));
  return user ? { token, session, user } : null;
}

function requireAuth(req, res) {
  const auth = getSession(req);
  if (!auth) sendError(res, 401, "Oturum acman gerekiyor.");
  return auth;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    userId: user.id,
    googleSub: user.googleSub,
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  });
  return token;
}

function sessionCookie(token, clear = false) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${clear ? 0 : SESSION_MAX_AGE}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

function createKankaId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let candidate;
  do {
    let suffix = "";
    for (let index = 0; index < 6; index += 1) {
      suffix += alphabet[crypto.randomInt(alphabet.length)];
    }
    candidate = `KANKA-${suffix}`;
  } while (state.users.some((user) => user.kankaId === candidate));
  return candidate;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.displayName || user.name,
    picture: user.picture || "",
    kankaId: user.kankaId,
    bio: user.bio || "",
    statusMessage: user.statusMessage || "",
  };
}

function ownUser(user) {
  return {
    ...publicUser(user),
    email: user.email,
    googleSub: user.googleSub,
    googleName: user.name,
    theme: user.theme === "light" ? "light" : "dark",
  };
}

function publicAttachment(attachment) {
  if (!attachment) return undefined;
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    isImage: attachment.isImage,
  };
}

function messagePayload(message, user) {
  return {
    id: message.id,
    roomId: message.roomId,
    userId: message.userId,
    type: message.type || (message.attachment ? "file" : "text"),
    content: message.content || "",
    attachment: publicAttachment(message.attachment),
    createdAt: message.createdAt,
    user: publicUser(user),
  };
}

function upsertUser(profile) {
  let user = state.users.find((entry) => entry.googleSub === profile.googleSub);
  if (!user) {
    user = {
      id: newId("usr"),
      googleSub: profile.googleSub,
      email: profile.email || "",
      name: profile.name || "Yeni Kanka",
      displayName: profile.name || "Yeni Kanka",
      picture: profile.picture || "",
      kankaId: createKankaId(),
      bio: "",
      statusMessage: "",
      theme: "dark",
      createdAt: new Date().toISOString(),
    };
    state.users.push(user);

    const room = {
      id: newId("room"),
      name: `${user.name.split(" ")[0]}'in Odasi`,
      ownerId: user.id,
      memberIds: [user.id],
      createdAt: new Date().toISOString(),
    };
    state.rooms.push(room);
  } else {
    user.email = profile.email || user.email;
    user.name = profile.name || user.name;
    user.picture = profile.picture || user.picture;
    user.displayName ||= user.name;
    user.bio ||= "";
    user.statusMessage ||= "";
    user.theme = user.theme === "light" ? "light" : "dark";
  }
  scheduleSave();
  return user;
}

function safeOriginalName(filename) {
  const extension = path.extname(filename).toLowerCase();
  const base = path.basename(filename, path.extname(filename))
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80) || "dosya";
  return `${base}${extension}`;
}

function validateFileSignature(buffer, extension) {
  if (extension === ".png") {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (extension === ".gif") {
    const header = buffer.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (extension === ".pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === ".zip" || extension === ".docx") {
    const isZip = buffer.length >= 4
      && buffer[0] === 0x50
      && buffer[1] === 0x4b
      && [0x03, 0x05, 0x07].includes(buffer[2])
      && [0x04, 0x06, 0x08].includes(buffer[3]);
    if (!isZip) return false;
    if (extension === ".docx") {
      return buffer.includes(Buffer.from("[Content_Types].xml"))
        && buffer.includes(Buffer.from("word/"));
    }
    return true;
  }
  if (extension === ".txt") {
    return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  }
  return false;
}

const localUploadStorage = {
  async save(buffer, extension) {
    const storageKey = `${crypto.randomUUID()}${extension}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, storageKey), buffer, { flag: "wx" });
    return storageKey;
  },
  async read(storageKey) {
    return fs.promises.readFile(path.join(UPLOAD_DIR, path.basename(storageKey)));
  },
};

function parseUpload(req) {
  return new Promise((resolve, reject) => {
    let upload;
    let caption = "";
    let rejected = false;

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 2 },
      });
    } catch {
      reject(new Error("Gecersiz dosya yukleme istegi."));
      return;
    }

    busboy.on("field", (name, value) => {
      if (name === "caption") caption = String(value).trim().slice(0, 500);
    });
    busboy.on("file", (name, stream, info) => {
      if (name !== "file" || upload) {
        stream.resume();
        return;
      }

      const originalName = safeOriginalName(info.filename || "dosya");
      const extension = path.extname(originalName).toLowerCase();
      const allowed = ALLOWED_UPLOADS.get(extension);
      const chunks = [];
      let size = 0;

      if (!allowed || !allowed.mimeTypes.includes(info.mimeType)) rejected = true;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (!rejected) chunks.push(chunk);
      });
      stream.on("limit", () => {
        rejected = true;
      });
      stream.on("end", () => {
        if (rejected) return;
        const buffer = Buffer.concat(chunks);
        if (!validateFileSignature(buffer, extension)) {
          rejected = true;
          return;
        }
        upload = {
          buffer,
          originalName,
          extension,
          mimeType: allowed.mimeTypes[0],
          size,
          isImage: allowed.isImage,
        };
      });
    });
    busboy.on("filesLimit", () => {
      rejected = true;
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (rejected) {
        reject(new Error("Dosya turu gecersiz veya dosya 10 MB sinirini asiyor."));
      } else if (!upload) {
        reject(new Error("Yuklenecek dosya bulunamadi."));
      } else {
        resolve({ upload, caption });
      }
    });
    req.pipe(busboy);
  });
}

function usersSharingRoomsWith(userId) {
  return new Set(
    state.rooms
      .filter((room) => room.memberIds.includes(userId))
      .flatMap((room) => room.memberIds),
  );
}

function roomForUser(roomId, userId) {
  return state.rooms.find(
    (room) => room.id === roomId && room.memberIds.includes(userId),
  );
}

function roomPayload(room) {
  return {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    createdAt: room.createdAt,
    members: room.memberIds
      .map((id) => state.users.find((user) => user.id === id))
      .filter(Boolean)
      .map(publicUser),
  };
}

function userRooms(userId) {
  return state.rooms
    .filter((room) => room.memberIds.includes(userId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(roomPayload);
}

function onlineUserIds() {
  return [...eventClients.entries()]
    .filter(([, connections]) => connections.size > 0)
    .map(([userId]) => userId);
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcastToUsers(userIds, event, payload) {
  for (const userId of new Set(userIds)) {
    const connections = eventClients.get(userId);
    if (!connections) continue;
    for (const response of connections) writeEvent(response, event, payload);
  }
}

function broadcastPresence() {
  const payload = { onlineUserIds: onlineUserIds() };
  for (const connections of eventClients.values()) {
    for (const response of connections) writeEvent(response, "presence", payload);
  }
}

function sendSocket(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function voicePeerPayload(socket) {
  return {
    peerId: socket.peerId,
    user: publicUser(socket.user),
    muted: Boolean(socket.muted),
  };
}

function broadcastVoiceRoom(roomId, payload, exceptSocket = null) {
  const peers = voiceRooms.get(roomId);
  if (!peers) return;
  for (const socket of peers.values()) {
    if (socket !== exceptSocket) sendSocket(socket, payload);
  }
}

function sendVoicePresence(roomId) {
  const peers = voiceRooms.get(roomId);
  const participants = peers
    ? [...peers.values()].map(voicePeerPayload)
    : [];
  broadcastVoiceRoom(roomId, {
    type: "voice-presence",
    roomId,
    participants,
  });
}

function leaveVoiceRoom(socket) {
  if (!socket.voiceRoomId) return;

  const roomId = socket.voiceRoomId;
  const peers = voiceRooms.get(roomId);
  if (peers) {
    peers.delete(socket.peerId);
    if (peers.size === 0) voiceRooms.delete(roomId);
  }

  socket.voiceRoomId = null;
  broadcastVoiceRoom(roomId, {
    type: "voice-peer-left",
    roomId,
    peerId: socket.peerId,
  });
  sendVoicePresence(roomId);
}

function joinVoiceRoom(socket, roomId) {
  const room = roomForUser(roomId, socket.user.id);
  if (!room) {
    sendSocket(socket, {
      type: "voice-error",
      message: "Bu ses odasina katilma yetkin yok.",
    });
    return;
  }

  leaveVoiceRoom(socket);
  if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
  const peers = voiceRooms.get(roomId);
  const existingPeers = [...peers.values()].map(voicePeerPayload);

  socket.voiceRoomId = roomId;
  socket.muted = false;
  peers.set(socket.peerId, socket);

  sendSocket(socket, {
    type: "voice-joined",
    roomId,
    peerId: socket.peerId,
    peers: existingPeers,
  });
  broadcastVoiceRoom(roomId, {
    type: "voice-peer-joined",
    roomId,
    peer: voicePeerPayload(socket),
  }, socket);
  sendVoicePresence(roomId);
}

function relayVoiceSignal(socket, message) {
  if (!socket.voiceRoomId || typeof message.targetPeerId !== "string") return;
  const peers = voiceRooms.get(socket.voiceRoomId);
  const target = peers?.get(message.targetPeerId);
  if (!target) return;

  const allowedTypes = new Set([
    "webrtc-offer",
    "webrtc-answer",
    "webrtc-ice-candidate",
  ]);
  if (!allowedTypes.has(message.type)) return;

  sendSocket(target, {
    type: message.type,
    roomId: socket.voiceRoomId,
    fromPeerId: socket.peerId,
    user: publicUser(socket.user),
    sdp: message.sdp,
    candidate: message.candidate,
  });
}

function handleVoiceSocketMessage(socket, rawMessage) {
  if (rawMessage.length > 250_000) {
    socket.close(1009, "Mesaj cok buyuk.");
    return;
  }

  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    sendSocket(socket, { type: "voice-error", message: "Gecersiz signaling mesaji." });
    return;
  }

  if (message.type === "join-voice" && typeof message.roomId === "string") {
    joinVoiceRoom(socket, message.roomId);
    return;
  }
  if (message.type === "leave-voice") {
    leaveVoiceRoom(socket);
    return;
  }
  if (message.type === "voice-mute-state" && socket.voiceRoomId) {
    socket.muted = Boolean(message.muted);
    broadcastVoiceRoom(socket.voiceRoomId, {
      type: "voice-peer-muted",
      roomId: socket.voiceRoomId,
      peerId: socket.peerId,
      muted: socket.muted,
    });
    sendVoicePresence(socket.voiceRoomId);
    return;
  }
  relayVoiceSignal(socket, message);
}

function notifyRoomMembers(room, event, payload) {
  broadcastToUsers(room.memberIds, event, payload);
}

function addEventClient(userId, res) {
  if (!eventClients.has(userId)) eventClients.set(userId, new Set());
  eventClients.get(userId).add(res);
  broadcastPresence();
}

function removeEventClient(userId, res) {
  const connections = eventClients.get(userId);
  if (!connections) return;
  connections.delete(res);
  if (connections.size === 0) eventClients.delete(userId);
  broadcastPresence();
}

async function handleGoogleLogin(req, res) {
  if (!GOOGLE_CLIENT_ID) {
    sendError(res, 503, "Google Client ID ayarlanmamis.");
    return;
  }

  const body = await readJson(req);
  if (!body.credential || typeof body.credential !== "string") {
    sendError(res, 400, "Google kimlik bilgisi eksik.");
    return;
  }

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: body.credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || payload.email_verified === false) {
      sendError(res, 401, "Google hesabi dogrulanamadi.");
      return;
    }

    const user = upsertUser({
      googleSub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    });
    const token = createSession(user);
    sendJson(res, 200, { user: ownUser(user) }, {
      "Set-Cookie": sessionCookie(token),
    });
  } catch (error) {
    console.error("Google girisi basarisiz:", error.message);
    sendError(res, 401, "Google oturumu dogrulanamadi.");
  }
}

async function handleDevLogin(req, res) {
  if (!ALLOW_DEV_LOGIN) {
    sendError(res, 404, "Bulunamadi.");
    return;
  }
  const body = await readJson(req);
  const name = String(body.name || "").trim().slice(0, 40);
  if (name.length < 2) {
    sendError(res, 400, "En az 2 karakterlik bir ad gir.");
    return;
  }

  const key = String(body.key || name).trim().toLocaleLowerCase("tr-TR");
  const user = upsertUser({
    googleSub: `dev:${key}`,
    email: `${key.replace(/[^a-z0-9]/g, "") || "test"}@local.test`,
    name,
    picture: "",
  });
  const token = createSession(user);
  sendJson(res, 200, { user: ownUser(user) }, {
    "Set-Cookie": sessionCookie(token),
  });
}

async function apiHandler(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      googleClientId: GOOGLE_CLIENT_ID,
      googleConfigured: Boolean(GOOGLE_CLIENT_ID),
      allowDevLogin: ALLOW_DEV_LOGIN,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/google") {
    await handleGoogleLogin(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/dev") {
    await handleDevLogin(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const auth = getSession(req);
    if (auth) sessions.delete(auth.token);
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": sessionCookie("", true),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const auth = getSession(req);
    sendJson(res, 200, { user: auth ? ownUser(auth.user) : null });
    return;
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      me: ownUser(auth.user),
      rooms: userRooms(auth.user.id),
      onlineUserIds: onlineUserIds(),
    });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/profile") {
    const body = await readJson(req);
    const displayName = String(body.displayName || "").trim().slice(0, 40);
    const bio = String(body.bio || "").trim().slice(0, 160);
    const statusMessage = String(body.statusMessage || "").trim().slice(0, 60);
    const theme = ["dark", "light"].includes(body.theme)
      ? body.theme
      : auth.user.theme;

    if (displayName.length < 2) {
      sendError(res, 400, "Gorunen ad en az 2 karakter olmali.");
      return;
    }

    auth.user.displayName = displayName;
    auth.user.bio = bio;
    auth.user.statusMessage = statusMessage;
    auth.user.theme = theme;
    scheduleSave();

    const sharedUserIds = usersSharingRoomsWith(auth.user.id);
    broadcastToUsers(sharedUserIds, "profile-updated", {
      user: publicUser(auth.user),
    });
    sendJson(res, 200, { user: ownUser(auth.user) });
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings/theme") {
    const body = await readJson(req);
    if (!["dark", "light"].includes(body.theme)) {
      sendError(res, 400, "Gecersiz tema.");
      return;
    }
    auth.user.theme = body.theme;
    scheduleSave();
    sendJson(res, 200, { theme: auth.user.theme });
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && req.method === "GET") {
    const message = state.messages.find(
      (entry) => entry.attachment?.id === fileMatch[1],
    );
    if (!message || !roomForUser(message.roomId, auth.user.id)) {
      sendError(res, 404, "Dosya bulunamadi.");
      return;
    }

    try {
      const attachment = message.attachment;
      const content = await localUploadStorage.read(attachment.storageKey);
      const disposition = attachment.isImage
        ? "inline"
        : "attachment";
      res.writeHead(200, {
        "Content-Type": attachment.mimeType,
        "Content-Length": content.length,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      });
      res.end(content);
    } catch {
      sendError(res, 404, "Dosya depolamada bulunamadi.");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    addEventClient(auth.user.id, res);
    req.on("close", () => removeEventClient(auth.user.id, res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(req);
    const name = String(body.name || "").trim().slice(0, 40);
    if (name.length < 2) {
      sendError(res, 400, "Oda adi en az 2 karakter olmali.");
      return;
    }
    const room = {
      id: newId("room"),
      name,
      ownerId: auth.user.id,
      memberIds: [auth.user.id],
      createdAt: new Date().toISOString(),
    };
    state.rooms.push(room);
    scheduleSave();
    notifyRoomMembers(room, "rooms-updated", { roomId: room.id });
    sendJson(res, 201, { room: roomPayload(room) });
    return;
  }

  const uploadMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/uploads$/);
  if (uploadMatch && req.method === "POST") {
    const room = roomForUser(uploadMatch[1], auth.user.id);
    if (!room) {
      sendError(res, 404, "Oda bulunamadi.");
      return;
    }

    try {
      const { upload, caption } = await parseUpload(req);
      const storageKey = await localUploadStorage.save(upload.buffer, upload.extension);
      const message = {
        id: newId("msg"),
        roomId: room.id,
        userId: auth.user.id,
        type: "file",
        content: caption,
        attachment: {
          id: newId("file"),
          originalName: upload.originalName,
          mimeType: upload.mimeType,
          size: upload.size,
          isImage: upload.isImage,
          storageKey,
        },
        createdAt: new Date().toISOString(),
      };
      state.messages.push(message);
      if (state.messages.length > 10_000) state.messages = state.messages.slice(-10_000);
      scheduleSave();
      const payload = messagePayload(message, auth.user);
      notifyRoomMembers(room, "chat-message", payload);
      sendJson(res, 201, { message: payload });
    } catch (error) {
      sendError(res, 400, error.message || "Dosya yuklenemedi.");
    }
    return;
  }

  const messagesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === "GET") {
    const room = roomForUser(messagesMatch[1], auth.user.id);
    if (!room) {
      sendError(res, 404, "Oda bulunamadi.");
      return;
    }
    const messages = state.messages
      .filter((message) => message.roomId === room.id)
      .slice(-200)
      .map((message) => messagePayload(
        message,
        state.users.find((user) => user.id === message.userId) || {
          id: "unknown",
          name: "Bilinmeyen Kullanici",
          displayName: "Bilinmeyen Kullanici",
          kankaId: "",
          picture: "",
        },
      ));
    sendJson(res, 200, { messages });
    return;
  }

  if (messagesMatch && req.method === "POST") {
    const room = roomForUser(messagesMatch[1], auth.user.id);
    if (!room) {
      sendError(res, 404, "Oda bulunamadi.");
      return;
    }
    const body = await readJson(req);
    const content = String(body.content || "").trim().slice(0, 2000);
    if (!content) {
      sendError(res, 400, "Bos mesaj gonderemezsin.");
      return;
    }
    const message = {
      id: newId("msg"),
      roomId: room.id,
      userId: auth.user.id,
      type: "text",
      content,
      createdAt: new Date().toISOString(),
    };
    state.messages.push(message);
    if (state.messages.length > 10_000) state.messages = state.messages.slice(-10_000);
    scheduleSave();
    const payload = messagePayload(message, auth.user);
    notifyRoomMembers(room, "chat-message", payload);
    sendJson(res, 201, { message: payload });
    return;
  }

  const inviteMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invites$/);
  if (inviteMatch && req.method === "POST") {
    const room = roomForUser(inviteMatch[1], auth.user.id);
    if (!room) {
      sendError(res, 404, "Oda bulunamadi.");
      return;
    }
    if (room.ownerId !== auth.user.id) {
      sendError(res, 403, "Bu odaya yalnizca oda sahibi davet gonderebilir.");
      return;
    }
    const body = await readJson(req);
    const kankaId = String(body.kankaId || "").trim().toUpperCase();
    const invitedUser = state.users.find((user) => user.kankaId === kankaId);
    if (!invitedUser) {
      sendError(res, 404, "Bu Kanka ID ile kayitli kullanici bulunamadi.");
      return;
    }
    if (room.memberIds.includes(invitedUser.id)) {
      sendError(res, 409, "Bu kullanici zaten odada.");
      return;
    }
    room.memberIds.push(invitedUser.id);
    scheduleSave();
    notifyRoomMembers(room, "rooms-updated", { roomId: room.id });
    sendJson(res, 200, {
      room: roomPayload(room),
      invitedUser: publicUser(invitedUser),
    });
    return;
  }

  const typingMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/typing$/);
  if (typingMatch && req.method === "POST") {
    const room = roomForUser(typingMatch[1], auth.user.id);
    if (!room) {
      sendError(res, 404, "Oda bulunamadi.");
      return;
    }
    notifyRoomMembers(
      room,
      "typing",
      { roomId: room.id, user: publicUser(auth.user), at: Date.now() },
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  sendError(res, 404, "API yolu bulunamadi.");
}

function serveStatic(req, res, url) {
  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
    sendError(res, 403, "Erisim reddedildi.");
    return;
  }

  const extensions = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexError, indexContent) => {
          if (indexError) {
            sendError(res, 404, "Sayfa bulunamadi.");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(indexContent);
        });
        return;
      }
      sendError(res, 500, "Dosya okunamadi.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": extensions[path.extname(filePath)] || "application/octet-stream",
      "Referrer-Policy": "no-referrer-when-downgrade",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cache-Control": [".html", ".css", ".js"].includes(path.extname(filePath))
        ? "no-cache"
        : "public, max-age=3600",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await apiHandler(req, res, url);
    } else if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, url);
    } else {
      sendError(res, 405, "Bu istek yontemi desteklenmiyor.");
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, error.message || "Sunucu hatasi.");
    else res.end();
  }
});

const voiceSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  try {
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
  } catch {
    socket.destroy();
    return;
  }

  const auth = getSession(req);
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  voiceSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
    webSocket.user = auth.user;
    webSocket.peerId = newId("peer");
    webSocket.voiceRoomId = null;
    webSocket.muted = false;
    voiceSocketServer.emit("connection", webSocket, req);
  });
});

voiceSocketServer.on("connection", (socket) => {
  sendSocket(socket, { type: "voice-ready", peerId: socket.peerId });
  socket.on("message", (message) => handleVoiceSocketMessage(socket, message));
  socket.on("close", () => leaveVoiceRoom(socket));
  socket.on("error", (error) => {
    console.error("Ses WebSocket hatasi:", error.message);
  });
});

setInterval(() => {
  for (const connections of eventClients.values()) {
    for (const response of connections) response.write(": ping\n\n");
  }
}, 25_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Kanka Chat hazir: http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`Yerel ag: http://${address.address}:${PORT}`);
      }
    }
  }
  if (!GOOGLE_CLIENT_ID) {
    console.log("Google girisi icin .env dosyasina GOOGLE_CLIENT_ID ekleyin.");
  }
  if (ALLOW_DEV_LOGIN) console.log("Yerel test girisi etkin.");
});
