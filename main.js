const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { fetchUsage } = require("./lib/usage");
const { beginLogin, completeLogin } = require("./lib/auth");

const POLL_MS = 10_000;
const WIDTH = 320;

let win = null;
let tray = null;
let pollTimer = null;
let lastPayload = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// --- persisted widget state (position) --------------------------------------

const stateFile = () => path.join(app.getPath("userData"), "widget-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }));
  } catch {}
}

function validPosition(x, y) {
  if (typeof x !== "number" || typeof y !== "number") return false;
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return x >= b.x - 50 && x < b.x + b.width - 50 && y >= b.y - 20 && y < b.y + b.height - 50;
  });
}

// --- window -----------------------------------------------------------------

function createWindow() {
  const state = loadState();
  const opts = {
    width: WIDTH,
    height: 220,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (validPosition(state.x, state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  }
  win = new BrowserWindow(opts);
  // 'screen-saver' level keeps it above normal always-on-top windows
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("moved", () => {
    const [x, y] = win.getPosition();
    saveState({ x, y });
  });
  // dev aid: WIDGET_CAPTURE=<path> saves a PNG of the rendered widget
  if (process.env.WIDGET_CAPTURE) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.WIDGET_CAPTURE, img.toPNG());
        console.log("[capture] saved", process.env.WIDGET_CAPTURE);
      } catch (e) {
        console.log("[capture] failed:", e.message);
      }
    }, 4000);
  }
  win.webContents.on("did-finish-load", () => {
    if (lastPayload) win.webContents.send("usage:data", lastPayload);
  });
}

// --- polling ----------------------------------------------------------------

async function poll() {
  let payload;
  try {
    const { data, plan } = await fetchUsage();
    payload = { ok: true, data, plan, fetchedAt: Date.now() };
  } catch (e) {
    // The usage endpoint serves fresh data ~once/min; between allowed
    // requests it 429s. Keep showing the last good data instead of an error.
    if (e.code === "HTTP_429" && lastPayload && lastPayload.ok) {
      return lastPayload;
    }
    payload = {
      ok: false,
      code: e.code === "HTTP_429" ? "RATE_LIMITED" : e.code || "ERROR",
      message:
        e.code === "HTTP_429"
          ? "Server is rate-limiting usage checks; retrying automatically…"
          : e.message,
      fetchedAt: Date.now(),
    };
  }
  lastPayload = payload;
  if (payload.ok) {
    const limits = (payload.data.limits || [])
      .map((l) => `${l.kind}:${l.percent}%`)
      .join(" ");
    console.log(`[poll] ok — ${limits}`);
  } else {
    console.log(`[poll] ${payload.code}: ${payload.message}`);
  }
  if (win && !win.isDestroyed()) win.webContents.send("usage:data", payload);
  updateTray(payload);
  return payload;
}

function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

// --- tray -------------------------------------------------------------------

function trayIcon() {
  const p = path.join(__dirname, "assets", "tray.png");
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function updateTray(payload) {
  if (!tray) return;
  if (payload.ok) {
    const worst = worstLimit(payload.data);
    const text = worst ? `${Math.round(worst.percent)}%` : "–";
    tray.setToolTip(`Claude usage — worst limit at ${text}`);
    if (process.platform === "darwin") tray.setTitle(` ${text}`);
  } else {
    tray.setToolTip(`Claude usage — ${payload.message}`);
    if (process.platform === "darwin") tray.setTitle(" !");
  }
}

function worstLimit(data) {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  if (!limits.length) return null;
  return limits.reduce((a, b) => (b.percent > a.percent ? b : a));
}

function createTray() {
  tray = new Tray(trayIcon());
  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: win && win.isVisible() ? "Hide widget" : "Show widget",
        click: () => {
          if (win.isVisible()) win.hide();
          else win.show();
          rebuild();
        },
      },
      { label: "Refresh now", click: () => poll() },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  tray.on("click", () => {
    if (win.isVisible()) win.hide();
    else win.show();
  });
}

// --- IPC --------------------------------------------------------------------

ipcMain.handle("usage:refresh", () => poll());
ipcMain.handle("auth:start", () => {
  const url = beginLogin();
  shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle("auth:submit", async (_e, pasted) => {
  try {
    await completeLogin(pasted);
    await poll();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
ipcMain.on("widget:resize", (_e, height) => {
  if (win && Number.isFinite(height)) {
    win.setContentSize(WIDTH, Math.max(40, Math.round(height)));
  }
});
ipcMain.on("widget:hide", () => win && win.hide());
ipcMain.on("widget:quit", () => app.quit());

// --- app lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) app.dock.hide(); // menu-bar-only widget
  createWindow();
  createTray();
  startPolling();
});

app.on("window-all-closed", () => {
  // keep running in the tray
});
