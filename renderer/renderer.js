const card = document.getElementById("card");
const rowsEl = document.getElementById("rows");
const messageEl = document.getElementById("message");
const updatedEl = document.getElementById("updated");
const planEl = document.getElementById("plan");
const summaryEl = document.getElementById("summary");
const loginEl = document.getElementById("login");
const loginStep2 = document.getElementById("login-step2");
const loginStatus = document.getElementById("login-status");
const loginCode = document.getElementById("login-code");
const loginBtn = document.getElementById("btn-login");
const loginSubmitBtn = document.getElementById("btn-login-submit");

let lastPayload = null;

// --- helpers ----------------------------------------------------------------

function labelFor(limit) {
  const model = limit.scope && limit.scope.model && limit.scope.model.display_name;
  switch (limit.kind) {
    case "session":
      return "Session (5h)";
    case "weekly_all":
      return "Weekly — all models";
    case "weekly_scoped":
      return model ? `Weekly — ${model}` : "Weekly — model";
    default:
      return model ? `${limit.kind} — ${model}` : limit.kind || "Limit";
  }
}

function shortLabelFor(limit) {
  const model = limit.scope && limit.scope.model && limit.scope.model.display_name;
  if (limit.kind === "session") return "5h";
  if (limit.kind === "weekly_all") return "Wk";
  if (limit.kind === "weekly_scoped") return model ? model.slice(0, 5) : "Wk*";
  return limit.kind || "?";
}

function resetsIn(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "resetting…";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${mm}m`;
  return `resets in ${mm}m`;
}

function normalizeLimits(data) {
  if (Array.isArray(data.limits) && data.limits.length) {
    return data.limits.map((l) => ({
      label: labelFor(l),
      short: shortLabelFor(l),
      percent: typeof l.percent === "number" ? l.percent : 0,
      severity: l.severity || "normal",
      resetsAt: l.resets_at,
    }));
  }
  // fallback for older/other response shapes
  const out = [];
  if (data.five_hour) {
    out.push({
      label: "Session (5h)",
      short: "5h",
      percent: data.five_hour.utilization || 0,
      severity: "normal",
      resetsAt: data.five_hour.resets_at,
    });
  }
  if (data.seven_day) {
    out.push({
      label: "Weekly — all models",
      short: "Wk",
      percent: data.seven_day.utilization || 0,
      severity: "normal",
      resetsAt: data.seven_day.resets_at,
    });
  }
  return out;
}

function agoText(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "updated just now";
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.floor(s / 60)}m ago`;
}

// --- rendering --------------------------------------------------------------

function render() {
  if (!lastPayload) return;

  if (!lastPayload.ok) {
    rowsEl.innerHTML = "";
    summaryEl.textContent = "⚠ error";
    messageEl.hidden = false;
    messageEl.textContent = lastPayload.message || "Something went wrong.";
    // offer sign-in when there's no usable login
    loginEl.hidden = !["NO_CREDENTIALS", "REFRESH_FAILED"].includes(lastPayload.code);
    updatedEl.textContent = agoText(lastPayload.fetchedAt);
    requestResize();
    return;
  }

  messageEl.hidden = true;
  loginEl.hidden = true;
  planEl.textContent = lastPayload.plan || "";
  const limits = normalizeLimits(lastPayload.data);

  rowsEl.innerHTML = "";
  for (const l of limits) {
    const pct = Math.min(100, Math.max(0, l.percent));
    const row = document.createElement("div");
    row.className = `row sev-${l.severity}`;

    const top = document.createElement("div");
    top.className = "row-top";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = l.label;
    const pctEl = document.createElement("span");
    pctEl.className = "row-pct";
    pctEl.textContent = `${Math.round(pct)}%`;
    top.append(label, pctEl);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${pct}%`;
    bar.append(fill);

    const reset = document.createElement("div");
    reset.className = "row-reset";
    reset.textContent = resetsIn(l.resetsAt);

    row.append(top, bar, reset);
    rowsEl.append(row);
  }

  summaryEl.innerHTML = "";
  for (const l of limits) {
    const mini = document.createElement("span");
    mini.className = "mini";
    const dot = document.createElement("span");
    dot.className = `mini-dot sev-${l.severity}`;
    const txt = document.createElement("span");
    txt.textContent = `${l.short} ${Math.round(l.percent)}%`;
    mini.append(dot, txt);
    summaryEl.append(mini);
  }

  updatedEl.textContent = agoText(lastPayload.fetchedAt);
  requestResize();
}

function requestResize() {
  requestAnimationFrame(() => {
    window.widget.resize(card.offsetHeight + 12); // card margin 6px each side
  });
}

// --- wiring -----------------------------------------------------------------

window.widget.onUsage((payload) => {
  lastPayload = payload;
  render();
});

document.getElementById("btn-refresh").addEventListener("click", () => {
  window.widget.refresh();
});

document.getElementById("btn-hide").addEventListener("click", () => {
  window.widget.hide();
});

const collapseBtn = document.getElementById("btn-collapse");
collapseBtn.addEventListener("click", () => {
  const collapsed = card.classList.toggle("collapsed");
  collapseBtn.title = collapsed ? "Expand" : "Collapse";
  try {
    localStorage.setItem("collapsed", collapsed ? "1" : "0");
  } catch {}
  requestResize();
});

if (localStorage.getItem("collapsed") === "1") {
  card.classList.add("collapsed");
  collapseBtn.title = "Expand";
}

// --- sign-in flow -----------------------------------------------------------

loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  loginStatus.classList.remove("error");
  loginStatus.textContent = "Opening your browser… sign in, then copy the code shown and paste it below.";
  loginStep2.hidden = false;
  try {
    await window.widget.authStart();
  } catch (e) {
    loginStatus.classList.add("error");
    loginStatus.textContent = "Could not open the browser. Try again.";
  }
  loginBtn.disabled = false;
  loginBtn.textContent = "Reopen sign-in page";
  loginCode.focus();
  requestResize();
});

async function submitLogin() {
  const code = loginCode.value.trim();
  if (!code) {
    loginCode.focus();
    return;
  }
  loginSubmitBtn.disabled = true;
  loginStatus.classList.remove("error");
  loginStatus.textContent = "Verifying…";
  const result = await window.widget.authSubmit(code);
  loginSubmitBtn.disabled = false;
  if (result.ok) {
    loginStatus.textContent = "";
    loginCode.value = "";
    loginStep2.hidden = true;
    loginBtn.textContent = "Sign in with Claude";
    // a successful submit already triggered a poll; render happens via onUsage
  } else {
    loginStatus.classList.add("error");
    loginStatus.textContent = result.message || "Sign-in failed. Try again.";
  }
  requestResize();
}

loginSubmitBtn.addEventListener("click", submitLogin);
loginCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitLogin();
});

// keep countdowns and "updated Xs ago" fresh between polls
setInterval(() => {
  if (lastPayload) render();
}, 30_000);

requestResize();
