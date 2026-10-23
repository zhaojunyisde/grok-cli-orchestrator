const STATUS_LABEL = {
  idle: "Idle",
  running: "Running",
  "waiting-permission": "Waiting for permission",
  done: "Done",
  error: "Error",
};

const ROLE_LABEL = {
  user: "You",
  orchestrator: "Orchestrator",
  hitl: "Permission",
};

const state = {
  mode: "",
  router: "",
  busy: false,
  dialog: [],
  sessions: [],
  hitl: null,
  connected: false,
};

const transcript = document.querySelector("#transcript");
const sessionsEl = document.querySelector("#sessions");
const banner = document.querySelector("#banner");
const modeEl = document.querySelector("#mode");
const connEl = document.querySelector("#conn");
const form = document.querySelector("#composer");
const input = document.querySelector("#input");
const sendButton = document.querySelector("#send");
const sampleButton = document.querySelector("#sample");
const formError = document.querySelector("#form-error");

let deciding = false;

function preview(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length > 2000) return `${text.slice(0, 2000)}…`;
  return text;
}

function setConnection(live) {
  state.connected = live;
  connEl.textContent = live ? "live" : "reconnecting";
  connEl.dataset.state = live ? "live" : "down";
  updateComposer();
}

function updateComposer() {
  sendButton.disabled = state.busy || !state.connected;
  sampleButton.disabled = state.busy;
  sendButton.textContent = state.busy ? "Working" : "Send";
}

function showFormError(text) {
  if (!text) {
    formError.hidden = true;
    formError.textContent = "";
    return;
  }
  formError.hidden = false;
  formError.textContent = text;
}

function appendMessage(message, scroll) {
  const article = document.createElement("article");
  article.className = `bubble ${message.role}`;
  article.dataset.id = String(message.id);
  const header = document.createElement("header");
  header.textContent = ROLE_LABEL[message.role] ?? message.role;
  const body = document.createElement("p");
  body.textContent = message.text;
  article.append(header, body);
  transcript.append(article);
  if (!scroll) return;
  const near = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  if (near) transcript.scrollTop = transcript.scrollHeight;
}

function renderDialog() {
  transcript.replaceChildren();
  if (state.dialog.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Messages you send stay here. Worker output stays in the session cards.";
    transcript.append(empty);
    return;
  }
  for (const message of state.dialog) appendMessage(message, false);
  transcript.scrollTop = transcript.scrollHeight;
}

function decisionButton(decision, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.decision = decision;
  button.className = decision;
  button.textContent = label;
  button.disabled = deciding;
  return button;
}

function fillPermission(container, hitl, kicker) {
  container.replaceChildren();
  if (!hitl) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  if (kicker) {
    const note = document.createElement("p");
    note.className = "banner-kicker";
    note.textContent = kicker;
    container.append(note);
  }
  const title = document.createElement("p");
  title.className = "hitl-title";
  title.textContent = hitl.title;
  container.append(title);
  if (hitl.rawInput !== undefined) {
    const pre = document.createElement("pre");
    pre.className = "hitl-input";
    pre.textContent = preview(hitl.rawInput);
    container.append(pre);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    decisionButton("allow", "Allow once"),
    decisionButton("deny", "Deny"),
    decisionButton("cancel", "Cancel"),
  );
  container.append(actions);
}

function renderBanner() {
  if (!state.hitl) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  fillPermission(banner, state.hitl, `${state.hitl.worker} is waiting for permission`);
}

function ensureCard(session) {
  let card = sessionsEl.querySelector(`[data-worker="${CSS.escape(session.name)}"]`);
  if (card) return card;
  card = document.createElement("article");
  card.className = "card";
  card.dataset.worker = session.name;

  const header = document.createElement("header");
  const titleWrap = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = session.name;
  const step = document.createElement("span");
  step.className = "step";
  heading.append(step);
  const gate = document.createElement("p");
  gate.className = "gate";
  titleWrap.append(heading, gate);
  const status = document.createElement("span");
  status.className = "status";
  header.append(titleWrap, status);

  const task = document.createElement("p");
  task.className = "task";
  const taskLabel = document.createElement("span");
  taskLabel.className = "k";
  taskLabel.textContent = "Subtask";
  const taskText = document.createElement("span");
  taskText.className = "task-text";
  task.append(taskLabel, taskText);

  const hitl = document.createElement("div");
  hitl.className = "card-hitl";
  hitl.hidden = true;

  const output = document.createElement("pre");
  output.className = "output";
  output.dataset.empty = "true";

  card.append(header, task, hitl, output);
  sessionsEl.append(card);
  return card;
}

function renderCard(session) {
  const card = ensureCard(session);
  card.dataset.status = session.status;
  const step = card.querySelector(".step");
  if (session.step > 0) {
    step.hidden = false;
    step.textContent = `Step ${session.step}`;
  } else {
    step.hidden = true;
    step.textContent = "";
  }
  card.querySelector(".gate").textContent = session.alwaysApprove ? "Always-approve" : "Asks before tools";
  card.querySelector(".status").textContent = STATUS_LABEL[session.status] ?? session.status;
  card.querySelector(".task-text").textContent = session.task || "No subtask this turn.";

  const output = card.querySelector(".output");
  if (output.textContent !== session.text) {
    const near = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
    output.textContent = session.text;
    output.dataset.empty = session.text ? "false" : "true";
    if (near) output.scrollTop = output.scrollHeight;
  } else {
    output.dataset.empty = session.text ? "false" : "true";
  }

  let error = card.querySelector(".error");
  if (session.error) {
    if (!error) {
      error = document.createElement("p");
      error.className = "error";
      card.querySelector(".task").after(error);
    }
    error.textContent = session.error;
  } else if (error) {
    error.remove();
  }

  const hitlBox = card.querySelector(".card-hitl");
  const mine = state.hitl && state.hitl.worker === session.name ? state.hitl : null;
  fillPermission(hitlBox, mine, "");
}

function renderSessions() {
  const names = new Set(state.sessions.map((session) => session.name));
  for (const card of sessionsEl.querySelectorAll(".card")) {
    if (!names.has(card.dataset.worker)) card.remove();
  }
  for (const session of state.sessions) renderCard(session);
}

function renderChrome() {
  modeEl.textContent = state.mode ? `${state.mode} · ${state.router}` : "connecting";
  updateComposer();
}

function renderAll() {
  renderChrome();
  renderDialog();
  renderSessions();
  renderBanner();
}

function upsertSession(session) {
  const index = state.sessions.findIndex((item) => item.name === session.name);
  if (index >= 0) state.sessions[index] = session;
  else state.sessions.push(session);
  renderCard(session);
}

function apply(event) {
  if (event.type === "snapshot") {
    state.mode = event.state.mode;
    state.router = event.state.router;
    state.busy = event.state.busy;
    state.dialog = event.state.dialog;
    state.sessions = event.state.sessions;
    state.hitl = event.state.hitl;
    renderAll();
    return;
  }
  if (event.type === "dialog") {
    state.dialog.push(event.message);
    if (transcript.querySelector(".empty")) transcript.replaceChildren();
    appendMessage(event.message, true);
    return;
  }
  if (event.type === "sessions") {
    state.sessions = event.sessions;
    renderSessions();
    return;
  }
  if (event.type === "session") {
    upsertSession(event.session);
    return;
  }
  if (event.type === "session_chunk") {
    const session = state.sessions.find((item) => item.name === event.name);
    if (!session) return;
    session.text += event.chunk;
    const card = sessionsEl.querySelector(`[data-worker="${CSS.escape(event.name)}"]`);
    const output = card?.querySelector(".output");
    if (!output) return;
    const near = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
    output.textContent = session.text;
    output.dataset.empty = session.text ? "false" : "true";
    if (near) output.scrollTop = output.scrollHeight;
    return;
  }
  if (event.type === "hitl") {
    state.hitl = event.hitl;
    if (!event.hitl) deciding = false;
    renderBanner();
    renderSessions();
    return;
  }
  if (event.type === "busy") {
    state.busy = event.busy;
    updateComposer();
    return;
  }
  if (event.type === "turn_finished") {
    state.busy = false;
    updateComposer();
    if (!event.ok && event.error) showFormError(event.error);
  }
}

async function sendMessage(text) {
  showFormError("");
  try {
    const response = await fetch("/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({}));
    showFormError(body.error || "Could not send that message.");
    if (response.status !== 409) input.value = text;
  } catch (error) {
    input.value = text;
    showFormError(error instanceof Error ? error.message : "Could not reach the desk.");
  }
}

async function sendDecision(id, decision) {
  if (deciding || !decision) return;
  deciding = true;
  for (const button of document.querySelectorAll("[data-decision]")) button.disabled = true;
  showFormError("");
  try {
    const response = await fetch("/hitl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    if (!response.ok) {
      deciding = false;
      const body = await response.json().catch(() => ({}));
      if (response.status !== 404) showFormError(body.error || "Could not send that decision.");
      renderBanner();
      renderSessions();
    }
  } catch (error) {
    deciding = false;
    showFormError(error instanceof Error ? error.message : "Could not reach the desk.");
    renderBanner();
    renderSessions();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  void sendMessage(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

sampleButton.addEventListener("click", () => {
  input.value = sampleButton.dataset.prompt ?? "";
  input.focus();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button || !state.hitl) return;
  void sendDecision(state.hitl.id, button.dataset.decision);
});

function connect() {
  const source = new EventSource("/events");
  source.onopen = () => setConnection(true);
  source.onerror = () => setConnection(false);
  source.onmessage = (event) => {
    setConnection(true);
    apply(JSON.parse(event.data));
  };
}

connect();
