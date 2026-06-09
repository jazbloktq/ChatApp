const WebSocket = require("ws");
const os = require("os");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const SERVER_VERSION = "1.2.0";
const GITHUB_SERVER_URL = "https://raw.githubusercontent.com/jazbloktq/ChatApp/refs/heads/main/src/server";
const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const SELF_PATH = path.resolve(__filename);
const DB_PATH = path.join(__dirname, "users.json");

function loadUserDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        parsed.nextUserId = Number(parsed.nextUserId) || 1;
        parsed.accounts = parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {};
        // tempBans persisted as { lowercaseUsername: unbanTimestampMs }
        parsed.tempBans = parsed.tempBans && typeof parsed.tempBans === "object" ? parsed.tempBans : {};
        return parsed;
      }
    }
  } catch {}
  return { nextUserId: 1, accounts: {}, tempBans: {} };
}

function saveUserDb(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("[accounts] Failed to save users.json:", e.message);
  }
}

function createDefaultProfile(displayName) {
  return {
    displayName: displayName || "Anonymous",
    aboutMe: "Hey there! I am using this cool chat.",
    avatarUrl: "",
    settings: {
      theme: "dark",
      fontSize: "14px",
      accentColor: "#00e5ff",
    },
  };
}

function normalizeAccount(username, account) {
  const profile = createDefaultProfile(account?.displayName || username);
  const settings = { ...profile.settings, ...(account?.settings || {}) };
  return {
    id: Number(account?.id) || 0,
    password: String(account?.password || ""),
    displayName: String(account?.displayName || username || "Anonymous").slice(0, 24),
    aboutMe: String(account?.aboutMe || profile.aboutMe).slice(0, 240),
    avatarUrl: String(account?.avatarUrl || "").slice(0, 500),
    deviceId: String(account?.deviceId || "").slice(0, 120),
    settings,
  };
}

function ensureAccountRecord(db, username, account) {
  const key = String(username || "").toLowerCase();
  const normalized = normalizeAccount(username, account);
  db.accounts[key] = normalized;
  return normalized;
}

function findAccountById(db, id) {
  const targetId = Number(id);
  if (!targetId) return null;
  for (const [username, account] of Object.entries(db.accounts || {})) {
    if (Number(account?.id) === targetId) {
      return { username, account: normalizeAccount(username, account) };
    }
  }
  return null;
}

function isUnlimitedDevice() {
  return process.platform === "win32" && fs.existsSync("C:\\Users\\mckeo");
}

function countAccountsForDevice(db, deviceId) {
  const key = String(deviceId || "").trim();
  if (!key) return 0;
  return Object.values(db.accounts || {}).filter(acc => String(acc?.deviceId || "") === key).length;
}

// ── SELF-UPDATE ──
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url + "?_=" + Date.now(), { headers: { "User-Agent": "LanChat-Updater/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchRaw(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parseServerVersion(src) {
  const m = src.match(/SERVER_VERSION\s*=\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function versionIsNewer(remote, local) {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

let updatePromptActive = false; // prevent stacking prompts

async function checkServerUpdate() {
  if (updatePromptActive) return;
  try {
    const src = await fetchRaw(GITHUB_SERVER_URL);
    const remoteVersion = parseServerVersion(src);
    if (!remoteVersion) return;
    if (!versionIsNewer(remoteVersion, SERVER_VERSION)) return;

    updatePromptActive = true;
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  ⚡  Server update available: v${SERVER_VERSION} → v${remoteVersion}`.padEnd(51) + `║`);
    console.log(`║  Update now? Server will restart automatically.  ║`);
    console.log(`╚══════════════════════════════════════════════════╝`);
    process.stdout.write("  → Update now? [Y/n]: ");

    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    // Read one line then close
    rl.once("line", async (answer) => {
      rl.close();
      updatePromptActive = false;
      const yes = answer.trim().toLowerCase();
      if (yes === "" || yes === "y" || yes === "yes") {
        console.log("\n[updater] Writing update…");
        fs.writeFileSync(SELF_PATH, src, "utf8");
        console.log("[updater] File written. Restarting…\n");

        // Notify connected clients
        try {
          const notice = JSON.stringify({ type: "system", text: "⚡ Server updating to v" + remoteVersion + " — reconnecting shortly…", context: "general", ts: Date.now() });
          for (const [ws] of clients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(notice);
          }
        } catch {}

        setTimeout(() => {
          const child = spawn(process.execPath, [SELF_PATH], {
            detached: true,
            stdio: "inherit",
            env: process.env,
            cwd: process.cwd()
          });
          child.unref();
          process.exit(0);
        }, 1500);
      } else {
        console.log("[updater] Skipped. Will ask again in 20 minutes.\n");
      }
    });

    // If stdin closes (non-interactive / piped), skip silently
    rl.once("close", () => {
      updatePromptActive = false;
    });

  } catch (e) {
    // Network unavailable or fetch failed — silently skip
  }
}

// Check after a short startup delay, then every 20 minutes
setTimeout(() => checkServerUpdate(), 10000);
setInterval(() => checkServerUpdate(), UPDATE_CHECK_INTERVAL_MS);

const http = require("http");
const PORT = process.env.PORT || 4242;

// HTTP server: plain requests return 200 OK (health checks), WS upgrades go to wss
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

const wss = new WebSocket.Server({ server: httpServer, maxPayload: 80 * 1024 * 1024 });
httpServer.listen(PORT, () => {
  console.log("[server] Listening on port " + PORT);
});

// Collect all IPs that belong to THIS machine so we can identify connections
// from the same device (host machine), whether they connect via localhost OR their LAN IP.
// This is the only reliable way to tell "this connection is from the server machine"
// vs "this is a remote user on the LAN who just connected to our IP".
const LOCAL_MACHINE_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
try {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of (iface || [])) {
      if (addr && addr.address) {
        LOCAL_MACHINE_IPS.add(addr.address);
        if (addr.family === "IPv4") LOCAL_MACHINE_IPS.add("::ffff:" + addr.address);
      }
    }
  }
} catch {}

const clients = new Map(); // ws -> { name, color, id }
const rooms = { general: [], random: [] }; // room -> message[]
const dmHistory = new Map(); // "id1:id2" -> message[]
const typingUsers = new Map(); // roomOrDm -> Set of names
const wbUsers = new Set(); // Set of clientIds currently in whiteboard
const groupCallMembers = new Set(); // Set of clientIds currently in the group call
const MAX_HISTORY = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Image/sticker report tracking: msgId -> Set of clientIds who reported
const imageReports = new Map();

// ── AI BOT ──
const AI_KEY = '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';
const AI_MODELS = [
  'google/gemma-3-27b-it:free',
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-4-scout:free',
  'openrouter/cypher-alpha:free',
];

function callOpenRouter(model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 800,
      messages,
    });
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_KEY,
        'HTTP-Referer': 'https://chatapp-4gbn.onrender.com',
        'X-Title': 'LAN Chat AI Bot',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error.message || 'API error'));
          const text = data.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('No response text'));
          resolve({ text, model: data.model || model });
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Build conversation history for AI context (last N messages in the room/DM)
function buildAiHistory(history, triggerMsgId) {
  // Take up to 20 messages before and including the trigger message
  const relevant = history
    .filter(m => m.text && !m._system && !m._pick && m.id <= triggerMsgId)
    .slice(-20);

  return relevant.map(m => ({
    role: 'user', // we flatten everything as user turns with name prefix for context
    content: `[${m.name}]: ${m.text}`,
  }));
}

async function handleAiCommand(ws, client, data, triggerMsg, room, isDM) {
  const prompt = data.text.slice(3).trim(); // strip "/ai"
  if (!prompt) return;

  const AI_BOT_COLOR = '#00e5ff';
  const AI_BOT_NAME = 'AI Bot';

  // Gather context history
  const history = isDM
    ? (dmHistory.get(dmKey(parseInt(data.toId), client.id)) || [])
    : (rooms[room] || []);

  const contextMessages = buildAiHistory(history, triggerMsg.id);

  // Build the messages array: system prompt + context + current query
  const systemPrompt = `You are AI Bot, a helpful assistant integrated into "A Cool Little Chat" — a peer-to-peer LAN group chat app. ` +
    `You are chatting directly with users — respond naturally and conversationally, like a person in a chat, not like an AI assistant on a website. ` +
    `Keep replies concise unless a detailed answer is genuinely needed. ` +
    `Do not use excessive formatting, headers, or bullet points for simple questions — just talk naturally. ` +
    `You have access to recent chat history for context. The user who invoked you is ${client.name}. ` +
    `Never pretend you are a human. Do not add preambles like "Sure!" or "Of course!" — just answer directly.\n\n` +
    `PLATFORM KNOWLEDGE — use this to answer questions about the chat app:\n` +
    `- This app is "A Cool Little Chat", a local-network (LAN) group chat. The host runs node server.js and shares their IP; others open index.html in a browser and connect.\n` +
    `- ROOMS: There are two public rooms: #general and #random. Click them in the sidebar to switch.\n` +
    `- DIRECT MESSAGES: Click any username in the sidebar (or a message name) to open a private DM with them.\n` +
    `- SENDING MESSAGES: Type in the box and press Enter (or click the send button). Shift+Enter adds a new line.\n` +
    `- REPLYING: Hover a message and click the reply arrow icon (↩) to reply to it. A banner shows at the bottom confirming the reply target.\n` +
    `- EDITING: Hover your own message and click the pencil icon to edit it. Press Enter to save or Escape to cancel.\n` +
    `- DELETING: Hold Shift, then hover a message — a trash icon appears. Click it to delete. The host can delete anyone's messages.\n` +
    `- FILE & IMAGE SHARING: Click the image icon in the input bar to attach a file or image (max 50 MB). You can also paste an image from your clipboard.\n` +
    `- REACTIONS & REPORTING: Hover images/stickers to see a report (🚩) button. If enough users report an image it is auto-removed.\n` +
    `- MUTING USERS: In a DM, click "Mute User" in the header to hide that person's messages locally (only affects your view).\n` +
    `- UNREAD BADGES: Red number badges on room/DM names show unread message counts.\n` +
    `- TAB NOTIFICATIONS: The browser tab title flashes "💬 New message!" when you receive a DM while the tab is in the background.\n` +
    `- DESKTOP / OS NOTIFICATIONS: The app is available as a native desktop application (Electron). In the desktop app, when someone @mentions you in a message, you receive a native OS notification (Windows notification popup) even if the app is minimised or in the background. These can be disabled in Profile Settings under the Notifications toggle. The app also shows an unread count badge on the taskbar icon.\n` +
    `- VIDEO CALLS (1-on-1): Click the 📞 button next to a user's name in the sidebar to start a video call. The call window can be dragged, resized, hidden (minimise button) or made fullscreen. Screen sharing is supported.\n` +
    `- GROUP CALLS: Click "👥 Group Call" in the room header to start or join a call with everyone in the room. Supports mute, screen share, grid view, and focused/PiP modes.\n` +
    `- WHITEBOARD: Click "🎨 Whiteboard" in the header to open a collaborative shared canvas. Multiple people can draw at the same time.\n` +
    `- SLASH COMMANDS (type / to see them all):\n` +
    `  /weather — live weather + 3-day forecast for Altona 3018, VIC\n` +
    `  /ai <question> — ask me (AI Bot) a question\n` +
    `  /help — show the full command list (only visible to you)\n` +
    `  /poll "Question" "Yes" "No" — create a live poll\n` +
    `  /pick "A" "B" "C" — random picker with slot-machine animation\n` +
    `  /timer 60 [label] — countdown timer everyone can see\n` +
    `  /draw — open a quick draw pad and send a sticker\n` +
    `  /rainbow /glow /fire /shake /invert — text effects (stackable!)\n` +
    `  /ttt — Tic-Tac-Toe (DM only)\n` +
    `  /connect4 — Connect Four (DM only)\n` +
    `  /pong — Pong (DM only)\n` +
    `  /tron — Tron light cycles (DM only)\n` +
    `  /barricade — Barricade board game (DM only)\n` +
    `- BARRICADE GAME: Classic board game. 9×9 grid. Each player has one pawn and up to 8 wall segments. On your turn you EITHER move your pawn OR place a barricade wall — not both. Walls are 2 cells long. You cannot place a wall that would completely block your opponent's only path. Cyan (X) starts at row 8 moving toward row 0; Red (O) starts at row 0 moving toward row 8. First to reach the opposite starting row wins.\n` +
    `- AUTO-CONNECT: On the connect screen the app automatically scans for servers on the local network.\n` +
    `- HOST FEATURES: The person running server.js is the host. They can delete any message. The host secret is printed in the server console — paste it as "ip#secret" in the Server IP field to get host privileges from another machine.\n` +
    `- RATE LIMITING: You can send 8 messages in quick succession, then there is a cooldown. A warning banner appears if you hit the limit.\n` +
    `_ CHARACTER LIMIT: 2000 Character message limit, message box stops accepting inputs once the limit is reached.\n` +
    `- CONTENT FILTER: Messages with slurs, hate speech, explicit content, or self-harm references are automatically blocked.\n` +
    `- HOSTING: To host, the user must have node.js installed, open command prompt then cd to the folder with index.html and server.js, then (in command prompt) run "node server.js".\n` +
    `- MOD/HOST TOOLS: The server host has a 🛡 Mod button in the header. Clicking it opens the Mod Menu where you can Kick (disconnect, can reconnect), Temp Ban (disconnect + block reconnect for a custom duration), or Timeout (block messages for a custom period) any user. Duration is configurable in minutes, hours, or days. There can be multiple hosts simultaneously — the person running server.js is always a host, and connecting from the same machine (localhost) or using the host secret also grants host privileges.\n` +
    `- ACCOUNTS LIMIT: Each device can have a maximum of 2 accounts. If you try to create a third, you'll be prompted to delete one of your existing accounts first. Devices that qualify for unlimited accounts (determined server-side) are exempt from this limit.\n` +
    `- ACCOUNT DELETION: On the account limit prompt, you can delete any of your existing device accounts. This removes them from both local storage and the server database.\n` +
    `- UPDATES: The app checks for updates automatically every 20 minutes and shows an update prompt if a newer version is available on GitHub.`;

  // Interleave context as a single user message for free models that don't support system roles well
  let apiMessages;
  if (contextMessages.length > 1) {
    const contextBlock = contextMessages.slice(0, -1).map(m => m.content).join('\n');
    apiMessages = [
      { role: 'user', content: systemPrompt + '\n\nRecent chat context:\n' + contextBlock + '\n\nNow answer this message from ' + client.name + ': ' + prompt },
    ];
  } else {
    apiMessages = [
      { role: 'user', content: systemPrompt + '\n\nAnswer this message from ' + client.name + ': ' + prompt },
    ];
  }

  let response = null;
  for (const model of AI_MODELS) {
    try {
      response = await callOpenRouter(model, apiMessages);
      break;
    } catch (e) {
      console.error(`[AI] Model ${model} failed:`, e.message);
    }
  }
  if (!response) console.error("[AI] All models failed.");

  let replyText;
  try {
    replyText = response ? response.text.trim() : 'Sorry, something went wrong.';
    if (!replyText) replyText = 'Sorry, something went wrong.';
  } catch (e) {
    replyText = 'Sorry, something went wrong.';
  }

  // Craft the AI bot reply message
  const botMsg = {
    type: 'message',
    id: nextMsgId(),
    name: AI_BOT_NAME,
    senderId: 0, // virtual sender
    color: AI_BOT_COLOR,
    text: replyText,
    image: null,
    sticker: null,
    file: null,
    poll: null,
    timer: null,
    effect: null,
    effects: null,
    pick: null,
    game: null,
    replyTo: { id: triggerMsg.id, name: triggerMsg.name, text: triggerMsg.text, image: null, file: null },
    ts: Date.now(),
    edited: false,
    isAiBot: true,
    avatarUrl: "",
  };

  if (isDM) {
    const toId = parseInt(data.toId);
    botMsg.dm = true;
    botMsg.toId = toId;
    botMsg.fromId = 0;
    botMsg.dmKey = dmKey(client.id, toId);
    const key = dmKey(client.id, toId);
    if (!dmHistory.has(key)) dmHistory.set(key, []);
    const hist = dmHistory.get(key);
    hist.push(botMsg);
    trimHistory(hist);
    // Send to both participants
    sendTo(ws, botMsg);
    for (const [ows, oc] of clients) {
      if (oc.id === toId) { sendTo(ows, botMsg); break; }
    }
  } else {
    botMsg.room = room;
    const hist = rooms[room];
    if (hist) { hist.push(botMsg); trimHistory(hist); }
    broadcastAll(botMsg);
  }
}

// ── WEATHER (Open-Meteo, free, no API key) ──
// Altona 3018, Victoria, Australia: lat -37.8679, lon 144.8281
function fetchWeatherAltona() {
  return new Promise((resolve, reject) => {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=-37.8679&longitude=144.8281" +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code" +
      "&timezone=Australia%2FMelbourne&forecast_days=3";
    const opts = { hostname: "api.open-meteo.com", path: url.replace("https://api.open-meteo.com", ""), headers: { "User-Agent": "LanChat-Weather/1.0" } };
    https.get(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const c = d.current;
          const daily = d.daily;

          const WMO = {
            0:"Clear sky", 1:"Mainly clear", 2:"Partly cloudy", 3:"Overcast",
            45:"Fog", 48:"Icy fog",
            51:"Light drizzle", 53:"Drizzle", 55:"Heavy drizzle",
            61:"Light rain", 63:"Rain", 65:"Heavy rain",
            71:"Light snow", 73:"Snow", 75:"Heavy snow",
            77:"Snow grains", 80:"Light showers", 81:"Showers", 82:"Heavy showers",
            85:"Snow showers", 86:"Heavy snow showers",
            95:"Thunderstorm", 96:"Thunderstorm with hail", 99:"Thunderstorm with heavy hail"
          };
          const windDir = (deg) => {
            const dirs = ["N","NE","E","SE","S","SW","W","NW"];
            return dirs[Math.round(deg / 45) % 8];
          };
          const wmoIcon = (code, isDay) => {
            if (code === 0) return isDay ? "☀️" : "🌙";
            if (code <= 2) return isDay ? "🌤️" : "🌙";
            if (code === 3) return "☁️";
            if (code <= 48) return "🌫️";
            if (code <= 55) return "🌦️";
            if (code <= 65) return "🌧️";
            if (code <= 77) return "❄️";
            if (code <= 82) return "🌦️";
            if (code <= 86) return "🌨️";
            return "⛈️";
          };

          const now = c;
          const cond = WMO[now.weather_code] || "Unknown";
          const icon = wmoIcon(now.weather_code, now.is_day);
          const wind = `${Math.round(now.wind_speed_10m)} km/h ${windDir(now.wind_direction_10m)}`;

          // 3 day forecast
          const days = ["Today","Tomorrow","Day 3"];
          const forecastLines = (daily.time || []).slice(0, 3).map((date, i) => {
            const dayIcon = wmoIcon(daily.weather_code[i], 1);
            const max = Math.round(daily.temperature_2m_max[i]);
            const min = Math.round(daily.temperature_2m_min[i]);
            const rain = daily.precipitation_sum[i] > 0 ? ` 💧${daily.precipitation_sum[i].toFixed(1)}mm` : "";
            return `  ${days[i]}: ${dayIcon} ${min}°–${max}°C${rain}`;
          }).join("\n");

          const text =
            `🌡️ Weather — Altona 3018, VIC\n` +
            `${icon} ${cond} · ${Math.round(now.temperature_2m)}°C (feels ${Math.round(now.apparent_temperature)}°C)\n` +
            `💧 Humidity: ${now.relative_humidity_2m}% · 💨 Wind: ${wind}\n\n` +
            `📅 3-Day Forecast:\n${forecastLines}`;

          resolve(text);
        } catch (e) { reject(e); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function broadcastWbUsers() {
  const names = [];
  for (const id of wbUsers) {
    for (const [, c] of clients) { if (c.id === id) { names.push(c.name); break; } }
  }
  broadcastAll({ type: "wbUsers", names });
}

const COLORS = ["#FF6B6B","#FFD93D","#6BCB77","#4D96FF","#F4A261","#A8DADC","#E76F51","#B5E48C","#C77DFF","#48CAE4"];
let clientIdCounter = 1;
let msgIdCounter = 1;
let userDb = loadUserDb();

// --- Rate limiting ---
// Bucket: allow 8 messages free, then exponential backoff
function makeRateState() {
  return { tokens: 8, lastRefill: Date.now(), penalty: 0, penaltyUntil: 0 };
}

function checkRate(state) {
  const now = Date.now();
  // Refill 1 token every 2s, max 8
  const elapsed = (now - state.lastRefill) / 1000;
  state.tokens = Math.min(8, state.tokens + elapsed * 0.5);
  state.lastRefill = now;

  if (now < state.penaltyUntil) {
    return { allowed: false, wait: Math.ceil((state.penaltyUntil - now) / 1000) };
  }

  if (state.tokens >= 1) {
    state.tokens -= 1;
    return { allowed: true };
  }

  // Out of tokens — exponential penalty
  state.penalty = state.penalty === 0 ? 2000 : Math.min(state.penalty * 2, 60000);
  state.penaltyUntil = now + state.penalty;
  return { allowed: false, wait: Math.ceil(state.penalty / 1000) };
}

// --- Helpers ---
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function colorForSeed(seed, fallbackIndex = 0) {
  const value = String(seed || "").trim().toLowerCase();
  if (!value) return COLORS[fallbackIndex % COLORS.length];
  return COLORS[hashString(value) % COLORS.length];
}

function dmKey(a, b) { return [a, b].sort().join(":"); }
function nextMsgId() { return msgIdCounter++; }

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function sendUserList() {
  const users = [...clients.values()]
    .filter(c => c?.name && c.name !== "null")
    .map(c => ({
    id: c.id,
    name: c.name,
    color: c.color,
    username: c.username || "",
    profile: c.profile || null,
    avatarUrl: c.profile?.avatarUrl || "",
    aboutMe: c.profile?.aboutMe || "",
    settings: c.profile?.settings || {},
    isAuthenticated: !!c.accountId,
  }));
  broadcastAll({ type: "users", users });
}

function sendWelcome(ws, client, extra = {}) {
  sendTo(ws, {
    type: "welcome",
    name: client.name,
    color: client.color,
    id: client.id,
    isHost: client.isHost,
    groupCallMembers: [...groupCallMembers],
    accountId: client.accountId || null,
    username: client.username || "",
    profile: client.profile || createDefaultProfile(client.name),
    ...extra,
  });

  for (const [room, history] of Object.entries(rooms)) {
    sendTo(ws, { type: "history", room, messages: history });
  }
}

function applyAccountToClient(client, username, account) {
  const normalized = normalizeAccount(username, account);
  client.accountId = normalized.id;
  client.username = String(username || "").toLowerCase();
  client.color = colorForSeed(client.username, client.id || 0);
  client.profile = {
    displayName: normalized.displayName,
    aboutMe: normalized.aboutMe,
    avatarUrl: normalized.avatarUrl,
    settings: normalized.settings,
  };
  client.name = normalized.displayName || username || "Anonymous";
  // NOTE: client.id is intentionally NOT overwritten here.
  // client.id stays as the session ID assigned at connection time (clientIdCounter++).
  // client.accountId holds the persistent account ID from the database.
  // Overwriting client.id with the account ID caused different counter sequences to
  // produce the same number, making two separate users indistinguishable to each other's clients.
  return normalized;
}

function trimHistory(hist) {
  while (hist.length > MAX_HISTORY) hist.shift();
}

function findMessage(id) {
  for (const hist of Object.values(rooms)) {
    const found = hist.find(m => m.id === id);
    if (found) return found;
  }
  for (const hist of dmHistory.values()) {
    const found = hist.find(m => m.id === id);
    if (found) return found;
  }
  return null;
}

function cleanFile(file) {
  if (!file?.data) return null;
  const data = String(file.data);
  const match = data.match(/^data:([^;,]+)?(;base64)?,/);
  if (!match || data.length > MAX_FILE_BYTES * 1.4) return null;
  return {
    name: String(file.name || "download").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120),
    type: String(file.type || match[1] || "application/octet-stream").slice(0, 100),
    size: Math.min(Number(file.size) || 0, MAX_FILE_BYTES),
    data
  };
}

function makeContextMessage(client, data, clientId, color) {
  const file = cleanFile(data.file);
  let image = null;
  if (data.image && !file) {
    const imgStr = String(data.image);
    if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(imgStr) && imgStr.length < 16 * 1024 * 1024) image = imgStr;
  }

  // Sticker (from /draw command)
  let sticker = null;
  if (data.sticker) {
    const stickerStr = String(data.sticker);
    if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(stickerStr) && stickerStr.length < 4 * 1024 * 1024) sticker = stickerStr;
  }

  let poll = null;
  if (data.poll) {
    const question = String(data.poll.question || "").trim().slice(0, 160);
    const options = (Array.isArray(data.poll.options) ? data.poll.options : [])
      .map(o => String(o || "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 8);
    if (question && options.length >= 2) {
      poll = { question, options, votes: {}, closed: false };
    }
  }

  // /timer
  let timer = null;
  if (data.timer) {
    const secs = Math.min(Math.max(1, parseInt(data.timer.seconds) || 0), 86400);
    if (secs > 0) {
      timer = { seconds: secs, label: String(data.timer.label || "").slice(0, 60), startedAt: Date.now() };
    }
  }

  // Chat effects
  const VALID_EFFECTS = ["shake", "rainbow", "invert", "glow", "fire"];
  const effect = VALID_EFFECTS.includes(data.effect) ? data.effect : null;
  // Stacked effects array
  const effects = Array.isArray(data.effects)
    ? data.effects.filter(e => VALID_EFFECTS.includes(e))
    : null;
  // Segments (partial-effect / quoted mode): [{text, effects:[]}]
  const segments = Array.isArray(data.segments)
    ? data.segments
        .filter(s => s && typeof s.text === "string")
        .map(s => ({
          text: String(s.text || "").slice(0, 2000),
          effects: Array.isArray(s.effects) ? s.effects.filter(e => VALID_EFFECTS.includes(e)) : [],
        }))
    : null;

  // /pick
  let pick = null;
  if (data.pick) {
    const options = (Array.isArray(data.pick.options) ? data.pick.options : [])
      .map(o => String(o || "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 16);
    if (options.length >= 2) {
      const chosen = options[Math.floor(Math.random() * options.length)];
      pick = { options, chosen };
    }
  }

  let game = null;
  if (data.game) {
    const kind = String(data.game.kind || "").toLowerCase();
    if (["tictactoe", "connect4", "tron", "pong", "barricade"].includes(kind)) {
      game = data.game;
    }
  }

  return {
    type: "message",
    id: nextMsgId(),
    name: client.name,
    senderId: clientId,
    color,
    text: String(data.text || "").slice(0, 6000),
    image,
    sticker,
    file,
    poll,
    timer,
    effect,
    effects,
    segments,
    pick,
    game,
    replyTo: null,
    ts: Date.now(),
    edited: false,
    avatarUrl: client.profile?.avatarUrl || "",
    displayName: client.profile?.displayName || client.name || "Anonymous",
    // Snapshot of ALL users at send time (including sender) for report threshold
    snapshotUsers: clients.size
  };
}

function sendMessageToContext(ws, client, data, msg, clientId) {
  const isDM = !!data.toId;
  if (isDM) {
    const toId = parseInt(data.toId);
    const key = dmKey(clientId, toId);
    msg.dm = true;
    msg.toId = toId;
    msg.fromId = clientId;
    msg.dmKey = key;
    if (!dmHistory.has(key)) dmHistory.set(key, []);
    const hist = dmHistory.get(key);
    hist.push(msg);
    trimHistory(hist);
    sendTo(ws, msg);
    for (const [ows, oc] of clients) {
      if (oc.id === toId) { sendTo(ows, msg); break; }
    }
  } else {
    msg.room = data.room || "general";
    const hist = rooms[msg.room];
    if (hist) {
      hist.push(msg);
      trimHistory(hist);
      broadcastAll(msg);
    }
  }
}

function normalizeMentionKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "");
}

function mentionKeyForUser(user) {
  return user?.username
    ? normalizeMentionKey(user.username)
    : normalizeMentionKey(user?.profile?.displayName || user?.name || "");
}

function resolveMentionsForMessage(data, senderId) {
  const ids = new Set();
  if (Array.isArray(data.mentions)) {
    for (const id of data.mentions) {
      const n = Number(id);
      if (n) ids.add(n);
    }
  }
  const text = String(data.text || "");
  const tokens = new Set();
  const re = /@([a-zA-Z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(text))) tokens.add(normalizeMentionKey(m[1]));
  if (!tokens.size) return [...ids];
  for (const c of clients.values()) {
    if (!c?.id || !c?.name || c.id === senderId) continue;
    const key = mentionKeyForUser(c);
    if (key && tokens.has(key)) ids.add(c.id);
  }
  return [...ids];
}

function broadcastTyping(context) {
  const set = typingUsers.get(context);
  const names = set ? [...set] : [];
  // Send to everyone involved
  for (const [ws, c] of clients) {
    if (!c.name) continue;
    // For DM context, only send to the two participants
    if (context.startsWith("dm:")) {
      const parts = context.slice(3).split(":");
      if (!parts.includes(c.id.toString())) continue;
    }
    sendTo(ws, { type: "typing", context, names });
  }
}

// --- Text Moderation ---
// Mild swears (f-word, s-word, etc.) are allowed.
// Slurs, hate speech, doxxing attempts, self-harm, and 18+ references are blocked.
//
// Five normalization passes are run and any match on any pass triggers a block:
//   pass 1 (denseE):    leet-speak with 3→e  (r3tard, h3ntai, f4gg0t)
//   pass 2 (denseG):    leet-speak with 3→g  (ni33er — user substitutes g with 3)
//   pass 3 (denseStarA): same but * → a      (f*ggot, f*ck)
//   pass 4 (denseStarU): same but * → u      (c*nt, f*ck)
//   pass 5 (spaced):    collapse spaced/separated chars ("n i g g e r", "n.i.g")
// All passes also:
//   - strip Unicode diacritics (nïgger, nígger → nigger)
//   - normalise ph→f (phaggot → faggot)
//   - normalise v→u before consonants (cvnt → cunt)
//   - collapse repeated-letter runs (niigger → nigger)
//   - expand * as vowel placeholder (n*gger, c*nt)

function _stripDiacritics(text) {
  // Decompose combined chars (é→e+´) then remove the combining marks, then drop any remaining non-ASCII
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7F]/g, "");
}

function _deduplicateRuns(text) {
  // Collapse 3+ identical letters to 2 (niiiigger→niigger), then collapse double vowels (niigger→nigger)
  return text.replace(/([a-z])\1{2,}/g, "$1$1").replace(/([aeiou])\1/g, "$1");
}

function _normalizeBase(text) {
  return _deduplicateRuns(
    _stripDiacritics(text)
      .toLowerCase()
      .replace(/ph/g, "f")             // ph → f
      .replace(/[^a-z0-9@$!|*]/g, "")  // strip everything except known substitutes
      .replace(/0/g, "o")
      .replace(/1/g, "i")
      .replace(/4/g, "a")
      .replace(/5/g, "s")
      .replace(/6/g, "b")
      .replace(/7/g, "t")
      .replace(/8/g, "b")
      .replace(/9/g, "g")
      .replace(/@/g, "a")
      .replace(/\$/g, "s")
      .replace(/!/g, "i")
      .replace(/\|/g, "i")
      .replace(/v(?=[^aeiou*0-9])/g, "u") // v→u only before consonants (cvnt→cunt, not 'love')
      .replace(/vv/g, "w")
  );
}

// Pass 1 — 3→e, *→i  (standard leet: r3tard, n*gger)
function normalizeDense(text) {
  return _normalizeBase(text).replace(/3/g, "e").replace(/\*/g, "i");
}
// Pass 2 — 3→g, *→i  (3-as-g evasion: ni33er)
function normalizeDenseG(text) {
  return _normalizeBase(text).replace(/3/g, "g").replace(/\*/g, "i");
}
// Pass 3 — 3→e, *→a  (star-as-a evasion: f*ggot)
function normalizeDenseStarA(text) {
  return _normalizeBase(text).replace(/3/g, "e").replace(/\*/g, "a");
}
// Pass 4 — 3→e, *→u  (star-as-u evasion: c*nt, f*ck)
function normalizeDenseStarU(text) {
  return _normalizeBase(text).replace(/3/g, "e").replace(/\*/g, "u");
}
// Pass 5 — spaced/separated chars ("n i g g e r", "n.i.g.g.e.r")
function normalizeSpaced(text) {
  return _deduplicateRuns(
    _stripDiacritics(text)
      .toLowerCase()
      .replace(/ph/g, "f")
      .replace(/([a-z0-9])[^a-z0-9]{0,3}(?=[a-z0-9])/g, "$1")
      .replace(/[^a-z0-9]/g, "")
  );
}

// Each entry: [pattern, bothPasses?]
// bothPasses=true means check in both spaced & dense form (evasion-prone terms).
// bothPasses=false (default) means dense only is sufficient.
const BLOCKED_PATTERNS = [
  // ── Racial / ethnic slurs ─────────────────────────────────────────
  [/nig/],                    // n-word and all variants/stems
  [/kike/],
  [/spic/],
  [/chink/],
  [/wetback/],
  [/gook/],
  [/jigaboo/],
  [/zipperhead/],
  [/raghead/],
  [/sandnig/],
  [/hajji/],
  [/beaner/],
  [/coon(?!ie)/],             // racial slur; avoid "coon" in "cookie"
  [/porch.*monkey/],
  [/jungle.*bunny/],
  [/mud.*shark/],
  [/moon.*cricket/],
  [/cracker.*ass/],           // racial compound only
  [/tranny/],
  [/faggot/],
  [/fag(?:got)?/],
  [/dyke(?!s?electric)/],     // slur sense; not "dykes" in engineering
  [/lesbo/],
  [/retar(?:d|ded)/],
  [/spaz(?:tic)?/],
  // ── Hate speech / extremism ───────────────────────────────────────
  [/whitesuprem/],
  [/whitepower/],
  [/heil.*hit/],
  [/hitlersright/],
  [/jewswill/],
  [/killall.*(?:blacks|whites|jews|muslims|christians|gays)/],
  [/14words/],                // white nationalist slogan
  [/1488/],                   // neo-nazi code
  [/rahowa/],                 // racial holy war
  [/iotbw/],                  // hate campaign
  // ── Sexual / adult content ────────────────────────────────────────
  [/porn/],
  [/hentai/],
  [/sexting/],
  [/cybersex/],
  [/pedo/],
  [/lolicon/],
  [/shotacon/],
  [/cock(?!ney|roach|atoo|pit|ney)/],  // exclude cockney/cockroach/cockatoo/cockpit
  [/penis/],
  [/vagina/],
  [/pussy(?!cat|foot|willow)/],
  [/cunt/],
  [/onlyfans/],
  [/stripp(?:er|ing)/],
  [/whore/],
  [/slut/],
  [/cumshot/],
  [/jizz/],
  [/boobs/],
  [/titties/],
  [/asshole/],
  [/anus/],
  [/anal(?!ysis|og|yze|yse)/],         // exclude analysis/analog/analyze
  [/dildo/],
  [/masturbat/],
  [/orgasm/],
  [/ejaculat/],
  [/bdsm/],
  [/fetish/],
  [/sexuallyexplicit/],
  // ── Self-harm / crisis ────────────────────────────────────────────
  [/kys/],
  [/killurself/],
  [/killyourself/],
  [/kms(?!per|sec|hour)/],    // not "kms" as kilometers
  [/howtosui/],               // "how to sui(cide)"
  [/cutmyself/],
  [/cutyourself/],
  [/slitmywrist/],
  [/endmylife/],
  [/wanttodie/],
  [/suicidemethod/],
  [/howtodie/],
  // ── Doxxing / personal info solicitation ─────────────────────────
  [/givemeyouraddress/],
  [/whatisyouraddress/],
  [/tellemewhereyoulive/],
  [/sendmenudes/],
  [/sendfeet/],
  [/agegender(?:loc|asl)/],
  // ── Spam signals ─────────────────────────────────────────────────
  [/discordnitro.*free/],
  [/freegiftcard/],
  [/clickthislink.*win/],
  // ── Sexual acts / explicit language ──────────────────────────────
  [/\bsex\b/],                         // standalone "sex" word
  [/sexu(?:al|ally)/],                 // sexual, sexually
  [/suck.*(?:my|ur|your|his|her)/],   // "suck my ..." harassment
  [/blow.*job/],
  [/handjob/],
  [/fingering/],
  [/deepthroat/],
  [/facefuck/],
  [/gangbang/],
  [/threesome/],
  [/incest/],
  [/rape(?:d|ing|r)?/],
  [/molest/],
  [/grope/],
  [/fap(?:ping)?/],
  [/horny/],
  [/nude(?:s)?/],
  [/naked(?:pic|photo|selfie)?/],
  [/nsfw/],
  [/18\+content/],
  [/onlyfan/],
  [/sexwork/],
  [/prostitut/],
  [/escort(?:service)?/],
  // ── Harassment / threats ─────────────────────────────────────────
  [/i(?:will|gonna|going)kill(?:you|u)/],
  [/(?:go|get)fuck(?:your|urself)/],
  [/fuckoff/],
  [/eatshit/],
  [/suckdick/],
  [/suckcock/],
  [/lickmy/],
  [/touchgrass/],                      // mild but often used with slurs
  [/touchkids/],
  [/rapechildren/],
];

function moderateText(text) {
  if (!text) return { ok: true };
  const passes = [
    normalizeDense(text),
    normalizeDenseG(text),
    normalizeDenseStarA(text),
    normalizeDenseStarU(text),
    normalizeSpaced(text),
  ];
  for (const [pattern] of BLOCKED_PATTERNS) {
    if (passes.some(p => pattern.test(p))) {
      return { ok: false, reason: "Your message was blocked by the content filter." };
    }
  }
  // Spam: repeated character runs (e.g. "aaaaaaaaa" > 8) or same word repeated 6+ times
  if (/(.)\1{8,}/.test(text)) return { ok: false, reason: "Your message was blocked by the content filter." };
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
    if (Math.max(...Object.values(freq)) >= 6) {
      return { ok: false, reason: "Your message was blocked by the content filter." };
    }
  }
  return { ok: true };
}

// --- Host secret (generated at startup, printed to console) ---
const HOST_SECRET = require("crypto").randomBytes(16).toString("hex");

// --- Mod state ---
// tempBans: persisted in users.json so bans survive server restarts and work
// across devices (ban is keyed by username, not device/socket).
const timeouts = new Map();   // key: clientId -> untilTimestamp

// Purge any bans that expired while the server was offline
(function purgeExpiredBans() {
  if (!userDb.tempBans) { userDb.tempBans = {}; return; }
  const now = Date.now();
  let dirty = false;
  for (const [k, v] of Object.entries(userDb.tempBans)) {
    if (now >= Number(v)) { delete userDb.tempBans[k]; dirty = true; }
  }
  if (dirty) saveUserDb(userDb);
})();

// Thin wrapper with the same .get/.set/.delete/.has interface as Map
const tempBans = {
  get(username) {
    const k = String(username || "").toLowerCase();
    const v = userDb.tempBans && userDb.tempBans[k];
    return v ? Number(v) : undefined;
  },
  set(username, until) {
    const k = String(username || "").toLowerCase();
    if (!userDb.tempBans) userDb.tempBans = {};
    userDb.tempBans[k] = Number(until);
    saveUserDb(userDb);
  },
  delete(username) {
    const k = String(username || "").toLowerCase();
    if (userDb.tempBans && k in userDb.tempBans) {
      delete userDb.tempBans[k];
      saveUserDb(userDb);
    }
  },
  has(username) {
    const k = String(username || "").toLowerCase();
    return !!(userDb.tempBans && userDb.tempBans[k]);
  },
};

// Copy "localhost#<secret>" to clipboard automatically
(function copyHostSecretToClipboard() {
  const text = `localhost#${HOST_SECRET}`;
  try {
    const { execSync } = require("child_process");
    const platform = process.platform;
    if (platform === "win32") {
      execSync(`echo ${text}| clip`, { stdio: ["ignore", "ignore", "ignore"] });
    } else if (platform === "darwin") {
      execSync(`echo -n '${text}' | pbcopy`, { stdio: ["ignore", "ignore", "ignore"] });
    } else {
      // Linux — try xclip, fall back to xsel
      try {
        execSync(`echo -n '${text}' | xclip -selection clipboard`, { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        execSync(`echo -n '${text}' | xsel --clipboard --input`, { stdio: ["ignore", "ignore", "ignore"] });
      }
    }
    console.log(`[HOST SECRET] | ${text}\n`);
  } catch {
    // Clipboard not available (e.g. headless/SSH) — silently skip
  }
})();

// --- Connection handler ---
wss.on("connection", (ws, req) => {
  const clientId = clientIdCounter++;
  const color = colorForSeed(`session:${clientId}`, clientId - 1);
  const rateState = makeRateState();
  const remoteIp = req.socket.remoteAddress || "";
  // Primary: localhost IP. Secondary: secret token passed in URL query (?secret=...)
  const urlParams = new URL("ws://x" + (req.url || "")).searchParams;
  const providedSecret = urlParams.get("secret") || "";
  const isLocalhost = LOCAL_MACHINE_IPS.has(remoteIp); // true if connecting from the server machine itself
  const usedHostSecret = !!(providedSecret && providedSecret === HOST_SECRET);
  // isHost is NOT granted at connection time — it is computed properly after login/register
  // (prevents every localhost user from inheriting host powers before auth)
  clients.set(ws, { name: null, color, id: clientId, sessionId: clientId, accountId: null, username: "", profile: createDefaultProfile("Anonymous"), isHost: false, isLocalhost, usedHostSecret });

  // Typing cleanup timers: context -> timeout
  const typingTimers = new Map();

  function clearTyping(context) {
    const set = typingUsers.get(context);
    if (set) {
      const client = clients.get(ws);
      if (client?.name) set.delete(client.name);
      broadcastTyping(context);
    }
    if (typingTimers.has(context)) {
      clearTimeout(typingTimers.get(context));
      typingTimers.delete(context);
    }
  }

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);
    // client.id is the stable session ID assigned at connection time.
    // It is used consistently everywhere: senderId on messages, DM keys, user list, welcome packet.
    const clientId = client.id;

    // --- REGISTER / LOGIN ---
    if (data.type === "register" || data.type === "login") {
      const username = String(data.username || "").trim().toLowerCase();
      const password = String(data.password || "");
      const deviceId = String(data.deviceId || "").trim().slice(0, 120);
      if (!username || !password) {
        sendTo(ws, { type: "error", message: "Username and password are required." });
        setTimeout(() => { try { ws.close(1008, "Missing credentials"); } catch {} }, 25);
        return;
      }

      userDb = loadUserDb();

      if (data.type === "register") {
        if (userDb.accounts[username]) {
          sendTo(ws, { type: "error", message: "Username taken!" });
          setTimeout(() => { try { ws.close(1008, "Username taken"); } catch {} }, 25);
          return;
        }
        if (!isUnlimitedDevice() && deviceId && countAccountsForDevice(userDb, deviceId) >= 2) {
          sendTo(ws, { type: "error", message: "This device already has the maximum of 2 accounts." });
          setTimeout(() => { try { ws.close(1008, "Account limit reached"); } catch {} }, 25);
          return;
        }
        const displayName = String(data.displayName || data.username || "").trim().slice(0, 24) || "Anonymous";
        const account = normalizeAccount(username, {
          id: userDb.nextUserId++,
          password,
          displayName,
          aboutMe: String(data.aboutMe || createDefaultProfile(displayName).aboutMe).slice(0, 240),
          avatarUrl: String(data.avatarUrl || "").slice(0, 500),
          deviceId,
          settings: { ...createDefaultProfile(displayName).settings, ...(data.settings || {}) },
        });
        userDb.accounts[username] = account;
        saveUserDb(userDb);
        applyAccountToClient(client, username, account);
        client.color = colorForSeed(username, client.id || 0);
        // Grant host only if this connection is from the server machine itself, or used the host secret.
        // LOCAL_MACHINE_IPS contains all of this machine's IPs (loopback + LAN), so this correctly
        // identifies the Electron app on the host device even when connecting via LAN IP.
        client.isHost = client.isLocalhost || client.usedHostSecret;
        sendWelcome(ws, client, { created: true });
        broadcast({ type: "system", text: `${client.name} joined`, context: "general", ts: Date.now() }, ws);
        broadcast({ type: "system", text: `${client.name} joined`, context: "random", ts: Date.now() }, ws);
        sendUserList();
        sendTo(ws, { type: "register_success", user: { id: client.id, name: client.name, username, profile: client.profile } });
        return;
      }

      let record = userDb.accounts[username];

      // ── AUTO-RESTORE ──
      // If the account doesn't exist (e.g. server restarted and wiped users.json)
      // but the client sent a deviceId + full profile, silently recreate it.
      // This makes server restarts invisible to users who already have an account
      // saved on their device.
      if (!record && deviceId && data.displayName) {
        console.log(`[auth] Auto-restoring account for "${username}" (server was restarted)`);
        const restored = normalizeAccount(username, {
          id: userDb.nextUserId++,
          password,
          displayName: String(data.displayName || username).trim().slice(0, 24),
          aboutMe: String(data.aboutMe || "").slice(0, 240),
          avatarUrl: String(data.avatarUrl || "").slice(0, 500),
          deviceId,
          settings: data.settings || {},
        });
        userDb.accounts[username] = restored;
        saveUserDb(userDb);
        record = restored;
      }

      if (!record || String(record.password || "") !== password) {
        sendTo(ws, { type: "error", message: "Invalid username or password" });
        setTimeout(() => { try { ws.close(1008, "Invalid auth"); } catch {} }, 25);
        return;
      }
      // Check if account is temp-banned
      const banUntil = tempBans.get(username);
      if (banUntil && Date.now() < banUntil) {
        const secs = Math.ceil((banUntil - Date.now()) / 1000);
        const mins = Math.ceil(secs / 60);
        sendTo(ws, { type: "error", message: `You are temp-banned for ${mins} more minute(s).` });
        setTimeout(() => { try { ws.close(1008, "Banned"); } catch {} }, 25);
        return;
      } else if (banUntil) {
        tempBans.delete(username); // expired
      }
      applyAccountToClient(client, username, record);
      client.color = colorForSeed(username, client.id || 0);
      // Grant host only if this connection is from the server machine itself, or used the host secret.
      client.isHost = client.isLocalhost || client.usedHostSecret;
      sendWelcome(ws, client);
      broadcast({ type: "system", text: `${client.name} joined`, context: "general", ts: Date.now() }, ws);
      broadcast({ type: "system", text: `${client.name} joined`, context: "random", ts: Date.now() }, ws);
      sendUserList();
      sendTo(ws, { type: "login_success", user: { id: client.id, name: client.name, username, profile: client.profile } });
      return;
    }

    // --- JOIN (legacy guest path — now blocked, accounts required) ---
    if (data.type === "join") {
      if (client.accountId) {
        // Already authenticated (e.g. reconnect path) — send welcome and continue
        sendWelcome(ws, client);
        return;
      }
      // Guest access disabled — require login/register
      sendTo(ws, { type: "error", message: "An account is required to join. Please sign in or create an account." });
      setTimeout(() => { try { ws.close(1008, "Account required"); } catch {} }, 25);
      return;
    }

    if (!client?.name) return;

    // --- TYPING ---
    if (data.type === "typing") {
      const context = data.context || "general";
      if (!typingUsers.has(context)) typingUsers.set(context, new Set());
      typingUsers.get(context).add(client.name);
      broadcastTyping(context);
      // Auto-clear after 4s
      if (typingTimers.has(context)) clearTimeout(typingTimers.get(context));
      typingTimers.set(context, setTimeout(() => clearTyping(context), 4000));
      return;
    }

    if (data.type === "stopTyping") {
      clearTyping(data.context || "general");
      return;
    }

    if (data.type === "update_profile") {
      if (!client.accountId) {
        sendTo(ws, { type: "error", message: "Log in to save profile changes." });
        return;
      }

      userDb = loadUserDb();
      const found = findAccountById(userDb, client.accountId);
      if (!found) {
        sendTo(ws, { type: "error", message: "Account not found." });
        return;
      }

      const account = userDb.accounts[found.username];
      account.displayName = String(data.displayName || account.displayName || "Anonymous").trim().slice(0, 24) || "Anonymous";
      account.aboutMe = String(data.aboutMe || account.aboutMe || "").slice(0, 240);
      account.avatarUrl = String(data.avatarUrl || account.avatarUrl || "").slice(0, 500);
      account.settings = {
        ...createDefaultProfile(account.displayName).settings,
        ...(account.settings || {}),
        ...(data.settings || {}),
      };
      saveUserDb(userDb);
      applyAccountToClient(client, found.username, account);
      // Broadcast profile update to ALL connected clients so everyone's avatar/name updates
      const profileUpdatePayload = {
        type: "profileUpdated",
        user: {
          id: client.id,
          name: client.name,
          username: found.username,
          profile: client.profile,
        },
      };
      broadcastAll(profileUpdatePayload);
      sendUserList();
      return;
    }

    // --- MESSAGE (room or DM) ---
    if (data.type === "message") {
      // Check server-side timeout
      const toUntil = timeouts.get(clientId);
      if (toUntil) {
        if (Date.now() < toUntil) {
          sendTo(ws, { type: "modBlocked", reason: "You are currently timed out." });
          return;
        } else {
          timeouts.delete(clientId); // expired
        }
      }
      const rate = checkRate(rateState);
      if (!rate.allowed) {
        sendTo(ws, { type: "rateLimit", wait: rate.wait });
        return;
      }

      const isDM = !!data.toId;
      let replyTo = null;
      if (data.replyToId) {
        const history = isDM ? (dmHistory.get(dmKey(clientId, data.toId)) || []) : (rooms[data.room] || []);
        const orig = history.find(m => m.id === data.replyToId);
        if (orig) replyTo = { id: orig.id, name: orig.name, text: orig.text, image: orig.image ? "[image]" : null, file: orig.file ? orig.file.name : null };
      }

      // Text moderation
      const textCheck = moderateText(String(data.text || ""));
      if (!textCheck.ok) {
        sendTo(ws, { type: "modBlocked", reason: textCheck.reason });
        return;
      }

      // ── /ai command ──
      if (String(data.text || "").trimStart().toLowerCase().startsWith("/ai ") ||
          String(data.text || "").trim().toLowerCase() === "/ai") {
        const aiPrompt = String(data.text || "").trim().slice(3).trim();
        if (!aiPrompt) {
          sendTo(ws, { type: "system", text: "Usage: /ai <your question>", context: data.room || "general", ts: Date.now() });
          return;
        }
        // Send the user's /ai message normally first so it appears in chat
        const triggerMsg = makeContextMessage(client, data, clientId, client.color);
        triggerMsg.replyTo = replyTo;
        const aiContext = isDM ? `dm:${dmKey(clientId, data.toId)}` : (data.room || "general");
        clearTyping(aiContext);
        sendMessageToContext(ws, client, data, triggerMsg, clientId);
        // Fire off async AI response (non-blocking)
        handleAiCommand(ws, client, data, triggerMsg, data.room || "general", isDM).catch(() => {});
        return;
      }

      // ── /weather command ──
      if (String(data.text || "").trim().toLowerCase() === "/weather" ||
          String(data.text || "").trim().toLowerCase().startsWith("/weather ")) {
        const weatherContext = isDM ? `dm:${dmKey(clientId, data.toId)}` : (data.room || "general");
        clearTyping(weatherContext);
        fetchWeatherAltona().then(weatherText => {
          const botMsg = {
            type: "message",
            id: nextMsgId(),
            name: "Weather Bot",
            senderId: 0,
            color: "#48CAE4",
            text: weatherText,
            image: null, sticker: null, file: null, poll: null, timer: null,
            effect: null, effects: null, pick: null, game: null,
            replyTo: null,
            ts: Date.now(),
            edited: false,
            snapshotUsers: 0,
            avatarUrl: "",
          };
          if (isDM) {
            const toId = parseInt(data.toId);
            botMsg.dm = true; botMsg.toId = toId; botMsg.fromId = 0; botMsg.dmKey = dmKey(clientId, toId);
            const key = dmKey(clientId, toId);
            if (!dmHistory.has(key)) dmHistory.set(key, []);
            dmHistory.get(key).push(botMsg);
            sendTo(ws, botMsg);
            for (const [ows, oc] of clients) { if (oc.id === toId) { sendTo(ows, botMsg); break; } }
          } else {
            botMsg.room = data.room || "general";
            const hist = rooms[botMsg.room];
            if (hist) { hist.push(botMsg); trimHistory(hist); }
            broadcastAll(botMsg);
          }
        }).catch(() => {
          sendTo(ws, { type: "system", text: "⚠ Could not fetch weather data. Try again later.", context: data.room || "general", ts: Date.now() });
        });
        return;
      }

      const msg = makeContextMessage(client, data, clientId, client.color);
      msg.replyTo = replyTo;

      // Clear typing on send
      const context = isDM ? `dm:${dmKey(clientId, data.toId)}` : (data.room || "general");
      clearTyping(context);

      sendMessageToContext(ws, client, data, msg, clientId);
      const mentionIds = resolveMentionsForMessage(data, clientId).filter(id => id !== clientId);
      if (mentionIds.length) {
        const payload = {
          type: "mention",
          fromId: clientId,
          fromName: client.name,
          messageId: msg.id,
          context: isDM ? `dm:${dmKey(clientId, data.toId)}` : (data.room || "general"),
          text: String(msg.text || ""),
        };
        for (const [ows, oc] of clients) {
          if (mentionIds.includes(oc.id)) sendTo(ows, payload);
        }
      }
      return;
    }

    // --- PICK SYSTEM ---
    if (data.type === "pickSystem") {
      const options = (Array.isArray(data.pick?.options) ? data.pick.options : [])
        .map(o => String(o || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 16);
      if (options.length < 2) return;
      const chosen = options[Math.floor(Math.random() * options.length)];
      const pick = { options, chosen };
      const isDM = !!data.toId;
      const pickMsg = {
        type: "pickSystem",
        pick,
        senderName: client.name,
        senderId: clientId,
        ts: Date.now()
      };
      if (isDM) {
        const toId = parseInt(data.toId);
        pickMsg.toId = toId;
        pickMsg.dm = true;
        for (const [ows, oc] of clients) {
          if (oc.id === toId || oc.id === clientId) sendTo(ows, pickMsg);
        }
      } else {
        const room = String(data.room || "general");
        pickMsg.room = room;
        broadcastAll(pickMsg);
      }
      return;
    }
    if (data.type === "pollVote") {
      const msg = findMessage(Number(data.id));
      if (!msg?.poll || msg.poll.closed) return;
      if (msg.dm && msg.fromId !== clientId && msg.toId !== clientId) return;
      const optionIndex = Number(data.optionIndex);
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= msg.poll.options.length) return;
      msg.poll.votes[clientId] = optionIndex;
      const update = { type: "pollUpdate", id: msg.id, votes: msg.poll.votes };
      if (msg.dm) {
        for (const [ows, oc] of clients) {
          if (oc.id === msg.fromId || oc.id === msg.toId) sendTo(ows, update);
        }
      } else {
        broadcastAll(update);
      }
      return;
    }

    // --- GAME PACKET ---
    if (data.type === "gamePacket") {
      const msg = findMessage(Number(data.id));
      if (!msg?.game || !msg.dm) return;
      if (msg.fromId !== clientId && msg.toId !== clientId) return;
      const packet = data.packet || {};
      msg.game.state = packet.state ?? msg.game.state;
      msg.game.turn = packet.turn ?? msg.game.turn;
      msg.game.status = packet.status ?? msg.game.status;
      msg.game.updatedAt = Date.now();
      const update = { type: "gameUpdate", id: msg.id, game: msg.game };
      for (const [ows, oc] of clients) {
        if (oc.id === msg.fromId || oc.id === msg.toId) sendTo(ows, update);
      }
      return;
    }

    // --- EDIT ---
    if (data.type === "edit") {
      const newText = String(data.text || "").trim().slice(0, 2000);
      if (!newText) return;

      // Text moderation on edits
      const editCheck = moderateText(newText);
      if (!editCheck.ok) {
        sendTo(ws, { type: "modBlocked", reason: editCheck.reason });
        return;
      }
      // Find in rooms or DM history
      let found = null;
      for (const hist of Object.values(rooms)) {
        found = hist.find(m => m.id === data.id && m.senderId === clientId);
        if (found) break;
      }
      if (!found) {
        for (const hist of dmHistory.values()) {
          found = hist.find(m => m.id === data.id && m.senderId === clientId);
          if (found) break;
        }
      }
      if (!found) return;
      found.text = newText;
      found.edited = true;
      broadcastAll({ type: "edited", id: data.id, text: newText });
      return;
    }

    // --- DELETE ---
    if (data.type === "delete") {
      const client = clients.get(ws);
      const canDeleteAny = client && client.isHost;
      let found = false;
      for (const hist of Object.values(rooms)) {
        const idx = hist.findIndex(m => m.id === data.id && (canDeleteAny || m.senderId === clientId));
        if (idx !== -1) { hist.splice(idx, 1); found = true; break; }
      }
      if (!found) {
        for (const hist of dmHistory.values()) {
          const idx = hist.findIndex(m => m.id === data.id && (canDeleteAny || m.senderId === clientId));
          if (idx !== -1) { hist.splice(idx, 1); found = true; break; }
        }
      }
      if (found) broadcastAll({ type: "deleted", id: data.id });
      return;
    }

    // --- IMAGE / STICKER REPORT ---
    if (data.type === "imageReport") {
      const msgId = Number(data.id);
      if (!msgId) return;

      // Initialize reporter set for this message
      if (!imageReports.has(msgId)) imageReports.set(msgId, new Set());
      const reporters = imageReports.get(msgId);
      reporters.add(clientId);

      // Find the message to get the snapshot of users at send time
      const reportedMsg = findMessage(msgId);
      // Use snapshotUsers stored at send time (including sender); fall back to current count
      const usersAtSendTime = reportedMsg?.snapshotUsers ?? clients.size;
      // Threshold = ceil(50% of total). 2→1, 3→2, 4→2, 5→3, 6→3
      const threshold = Math.max(1, Math.ceil(usersAtSendTime * 0.5));

      // Broadcast current report count so clients can show "X reported"
      broadcastAll({ type: "reportUpdate", id: msgId, count: reporters.size, threshold });

      if (reporters.size >= threshold) {
        // Auto-delete the reported message
        let found = false;
        for (const hist of Object.values(rooms)) {
          const idx = hist.findIndex(m => m.id === msgId);
          if (idx !== -1) { hist.splice(idx, 1); found = true; break; }
        }
        if (!found) {
          for (const hist of dmHistory.values()) {
            const idx = hist.findIndex(m => m.id === msgId);
            if (idx !== -1) { hist.splice(idx, 1); found = true; break; }
          }
        }
        if (found) {
          broadcastAll({ type: "deleted", id: msgId, reason: "reported" });
          imageReports.delete(msgId);
        }
      }
      return;
    }

    // --- DM HISTORY REQUEST ---
    if (data.type === "getDmHistory") {
      const toId = parseInt(data.toId);
      const key = dmKey(clientId, toId);
      sendTo(ws, { type: "dmHistory", toId, messages: dmHistory.get(key) || [] });
      return;
    }

// --- WebRTC SIGNALING ROUTER ---
    if (data.type === "rtcSignaling") {
      const toId = parseInt(data.toId);
      if (!toId) return;
      const signalingPayload = {
        type: "rtcSignaling",
        fromId: clientId,
        payload: data.payload
      };
      for (const [ows, oc] of clients) {
        if (oc.id === toId) {
          sendTo(ows, signalingPayload);
          break;
        }
      }
      return;
    }

    // --- CALL REJECT SIGNAL ---
    if (data.type === "callReject") {
      const toId = parseInt(data.toId);
      if (!toId) return;
      for (const [ows, oc] of clients) {
        if (oc.id === toId) {
          sendTo(ows, { type: "callReject", fromId: clientId });
          break;
        }
      }
      return;
    }

    // --- GROUP CALL SIGNALING ---
    // groupCallInvite: broadcast to a room so everyone gets invited
    if (data.type === "groupCallInvite") {
      const room = String(data.room || "general");
      broadcastAll({
        type: "groupCallInvite",
        fromId: clientId,
        fromName: clients.get(ws)?.name || "Unknown",
        room,
        ts: Date.now()
      });
      return;
    }
    // groupCallJoin / groupCallLeave: broadcast to all so everyone updates their peer list
    if (data.type === "groupCallJoin") {
      groupCallMembers.add(clientId);
      broadcastAll({ type: "groupCallJoin", fromId: clientId, fromName: clients.get(ws)?.name || "Unknown" });
      return;
    }
    if (data.type === "groupCallLeave") {
      groupCallMembers.delete(clientId);
      broadcastAll({ type: "groupCallLeave", fromId: clientId });
      return;
    }
    // groupRtcSignaling: routed point-to-point (mesh) — same as rtcSignaling but namespaced for group
    if (data.type === "groupRtcSignaling") {
      const toId = parseInt(data.toId);
      if (!toId) return;
      for (const [ows, oc] of clients) {
        if (oc.id === toId) {
          sendTo(ows, { type: "groupRtcSignaling", fromId: clientId, payload: data.payload });
          break;
        }
      }
      return;
    }

    // --- MOD ACTIONS (host only) ---
    if (data.type === "modAction") {
      if (!client.isHost) return; // only host can moderate
      const targetId = parseInt(data.targetId);
      const action = String(data.action || "");
      const durationSeconds = Math.max(0, parseInt(data.durationSeconds) || 0);

      // Find the target client
      let targetWs = null, targetClient = null;
      for (const [ows, oc] of clients) {
        if (oc.id === targetId) { targetWs = ows; targetClient = oc; break; }
      }
      if (!targetClient) return;

      if (action === "kick") {
        broadcastAll({ type: "modKicked", targetId, byName: client.name });
        setTimeout(() => {
          try { targetWs?.close(1008, "Kicked by host"); } catch {}
        }, 300);
      } else if (action === "tempban") {
        const until = Date.now() + durationSeconds * 1000;
        if (targetClient.username) tempBans.set(targetClient.username.toLowerCase(), until);
        broadcastAll({ type: "modBanned", targetId, byName: client.name, durationSeconds });
        setTimeout(() => {
          try { targetWs?.close(1008, "Temp-banned by host"); } catch {}
        }, 300);
        // Auto-clear ban after duration
        setTimeout(() => {
          if (targetClient.username) tempBans.delete(targetClient.username.toLowerCase());
        }, durationSeconds * 1000 + 5000);
      } else if (action === "timeout") {
        const until = Date.now() + durationSeconds * 1000;
        timeouts.set(targetId, until);
        broadcastAll({ type: "modTimedOut", targetId, byName: client.name, durationSeconds });
        // Also notify the timed-out client specifically
        if (targetWs) sendTo(targetWs, { type: "modTimedOut", targetId, byName: client.name, durationSeconds });
        // Auto-clear timeout
        setTimeout(() => { timeouts.delete(targetId); }, durationSeconds * 1000 + 5000);
      }
      return;
    }

    // --- DELETE ACCOUNT (client request — removes from server DB) ---
    if (data.type === "deleteAccount") {
      const username = String(data.username || "").trim().toLowerCase();
      if (!username) return;
      // Only allow if it's the requester's own account or requester is host
      const isOwn = client.username && client.username.toLowerCase() === username;
      const isHostReq = client.isHost;
      if (!isOwn && !isHostReq) {
        sendTo(ws, { type: "deleteAccountResult", ok: false, error: "Not authorized." });
        return;
      }
      userDb = loadUserDb();
      if (userDb.accounts[username]) {
        delete userDb.accounts[username];
        saveUserDb(userDb);
        sendTo(ws, { type: "deleteAccountResult", ok: true });
        // If they deleted their own account, disconnect them
        if (isOwn) {
          setTimeout(() => { try { ws.close(1008, "Account deleted"); } catch {} }, 300);
        }
      } else {
        sendTo(ws, { type: "deleteAccountResult", ok: false, error: "Account not found." });
      }
      return;
    }

    // --- WHITEBOARD ---
    if (data.type === "wbJoin") {
      if (!wbUsers.has(clientId)) wbUsers.add(clientId);
      broadcastWbUsers();
      return;
    }

    if (data.type === "wbLeave") {
      wbUsers.delete(clientId);
      broadcastWbUsers();
      return;
    }

    if (data.type === "wbDraw") {
      // Relay draw stroke to all others
      const stroke = JSON.stringify({
        type: "wbDraw",
        x1: Number(data.x1) || 0, y1: Number(data.y1) || 0,
        x2: Number(data.x2) || 0, y2: Number(data.y2) || 0,
        color: String(data.color || "#fff").slice(0, 10),
        size: Math.min(Math.max(1, Number(data.size) || 5), 60),
        erase: !!data.erase
      });
      for (const [ows] of clients) {
        if (ows !== ws && ows.readyState === WebSocket.OPEN) ows.send(stroke);
      }
      return;
    }

    if (data.type === "wbClear") {
      broadcast({ type: "wbClear" }, ws);
      return;
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client?.name) {
      broadcast({ type: "system", text: `${client.name} left`, context: "general", ts: Date.now() });
      broadcast({ type: "system", text: `${client.name} left`, context: "random", ts: Date.now() });
      // Clear all typing
      for (const context of typingTimers.keys()) clearTyping(context);
      // Remove from whiteboard users
      wbUsers.delete(client.id);
      broadcastWbUsers();
      // Remove from group call if they were in one (covers browser-close without a clean leave)
      if (groupCallMembers.delete(client.id)) {
        broadcastAll({ type: "groupCallLeave", fromId: client.id });
      }
    }
    clients.delete(ws);
    sendUserList();
  });
});

console.log("\n╔══════════════════════════════════════╗");
console.log("║   Chat Server running on port: " + PORT + "   ║");
console.log("╚══════════════════════════════════════╝\n");
console.log("Server is live. Share your Render URL with users.\n");
