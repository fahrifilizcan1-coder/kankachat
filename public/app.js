const state = {
  config: null,
  me: null,
  rooms: [],
  activeRoomId: null,
  messages: [],
  onlineUserIds: new Set(),
  unread: new Map(),
  typing: new Map(),
  eventSource: null,
  lastTypingSentAt: 0,
  voice: {
    socket: null,
    socketPromise: null,
    localStream: null,
    roomId: null,
    selfPeerId: null,
    joined: false,
    joining: false,
    muted: false,
    cameraEnabled: false,
    screenSharing: false,
    cameraStream: null,
    screenStream: null,
    videoCollapsed: false,
    peers: new Map(),
    participants: new Map(),
  },
};

let googleScriptPromise = null;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Map([
  [".png", ["image/png"]],
  [".jpg", ["image/jpeg", "image/jpg"]],
  [".jpeg", ["image/jpeg", "image/jpg"]],
  [".gif", ["image/gif"]],
  [".pdf", ["application/pdf"]],
  [".docx", [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
  ]],
  [".txt", ["text/plain"]],
  [".zip", ["application/zip", "application/x-zip-compressed", "application/octet-stream"]],
]);

const elements = {
  authView: document.querySelector("#auth-view"),
  appView: document.querySelector("#app-view"),
  googleButton: document.querySelector("#google-button"),
  googleFallbackButton: document.querySelector("#google-fallback-button"),
  googleLoading: document.querySelector("#google-loading"),
  setupWarning: document.querySelector("#setup-warning"),
  googleError: document.querySelector("#google-error"),
  googleErrorMessage: document.querySelector("#google-error-message"),
  googleRetryButton: document.querySelector("#google-retry-button"),
  devLogin: document.querySelector("#dev-login"),
  devLoginForm: document.querySelector("#dev-login-form"),
  myKankaId: document.querySelector("#my-kanka-id"),
  myName: document.querySelector("#my-name"),
  myStatus: document.querySelector("#my-status"),
  myAvatar: document.querySelector("#my-avatar"),
  roomList: document.querySelector("#room-list"),
  activeRoomName: document.querySelector("#active-room-name"),
  activeRoomSubtitle: document.querySelector("#active-room-subtitle"),
  messages: document.querySelector("#messages"),
  memberList: document.querySelector("#member-list"),
  memberCount: document.querySelector("#member-count"),
  typingIndicator: document.querySelector("#typing-indicator"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  messageCount: document.querySelector("#message-count"),
  inviteButton: document.querySelector("#invite-button"),
  modalBackdrop: document.querySelector("#modal-backdrop"),
  createRoomModal: document.querySelector("#create-room-modal"),
  inviteModal: document.querySelector("#invite-modal"),
  createRoomForm: document.querySelector("#create-room-form"),
  inviteForm: document.querySelector("#invite-form"),
  roomSidebar: document.querySelector("#room-sidebar"),
  membersPanel: document.querySelector("#members-panel"),
  joinVoiceButton: document.querySelector("#join-voice-button"),
  muteVoiceButton: document.querySelector("#mute-voice-button"),
  leaveVoiceButton: document.querySelector("#leave-voice-button"),
  toggleCameraButton: document.querySelector("#toggle-camera-button"),
  shareScreenButton: document.querySelector("#share-screen-button"),
  voiceStatus: document.querySelector("#voice-status"),
  voiceAudioRoot: document.querySelector("#voice-audio-root"),
  videoStage: document.querySelector("#video-stage"),
  videoStageStatus: document.querySelector("#video-stage-status"),
  videoGrid: document.querySelector("#video-grid"),
  collapseVideoButton: document.querySelector("#collapse-video-button"),
  fileButton: document.querySelector("#file-button"),
  fileInput: document.querySelector("#file-input"),
  profileModal: document.querySelector("#profile-modal"),
  profileForm: document.querySelector("#profile-form"),
  profileAvatar: document.querySelector("#profile-avatar"),
  profileDisplayName: document.querySelector("#profile-display-name"),
  profileStatus: document.querySelector("#profile-status"),
  profileBio: document.querySelector("#profile-bio"),
  profileGoogleInfo: document.querySelector("#profile-google-info"),
  profileEmail: document.querySelector("#profile-email"),
  profileKankaId: document.querySelector("#profile-kanka-id"),
  userProfileModal: document.querySelector("#user-profile-modal"),
  viewProfileAvatar: document.querySelector("#view-profile-avatar"),
  viewProfileName: document.querySelector("#view-profile-name"),
  viewProfileStatus: document.querySelector("#view-profile-status"),
  viewProfileBio: document.querySelector("#view-profile-bio"),
  viewProfileKankaId: document.querySelector("#view-profile-kanka-id"),
  settingsModal: document.querySelector("#settings-modal"),
};

document.addEventListener("DOMContentLoaded", initialize);

function on(element, eventName, handler, selector, options) {
  if (!element) return false;
  element.addEventListener(eventName, handler, options);
  return true;
}

async function initialize() {
  bindEvents();

  try {
    state.config = await api("/api/config");
  } catch (error) {
    state.config = {
      googleClientId: "",
      googleConfigured: false,
      allowDevLogin: false,
    };
    showToast("Giriş yapılandırması alınamadı.", "error");
  }

  try {
    const meResponse = await api("/api/me");
    if (meResponse.user) {
      state.me = meResponse.user;
      await enterApp();
    } else {
      showAuth();
    }
  } catch (error) {
    if (error.status && error.status !== 401) {
      showToast(error.message, "error");
    }
    showAuth();
  }
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const error = new Error(body.error || "Bir şeyler ters gitti.");
    error.status = response.status;
    throw error;
  }
  return body;
}

function bindEvents() {
  on(elements.devLoginForm, "submit", handleDevLogin, "#dev-login-form");
  on(elements.messageForm, "submit", sendMessage, "#message-form");
  on(elements.messageInput, "input", handleMessageInput, "#message-input");
  on(elements.messageInput, "keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.messageForm?.requestSubmit();
    }
  }, "#message-input");

  on(document.querySelector("#new-room-button"), "click", () => {
    openModal(elements.createRoomModal);
    setTimeout(() => document.querySelector("#room-name")?.focus(), 50);
  }, "#new-room-button");
  on(elements.inviteButton, "click", () => {
    openModal(elements.inviteModal);
    setTimeout(() => document.querySelector("#invite-id")?.focus(), 50);
  }, "#invite-button");
  on(elements.createRoomForm, "submit", createRoom, "#create-room-form");
  on(elements.inviteForm, "submit", inviteFriend, "#invite-form");
  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    on(button, "click", closeModals, "[data-close-modal]");
  });
  on(elements.modalBackdrop, "click", (event) => {
    if (event.target === elements.modalBackdrop) closeModals();
  }, "#modal-backdrop");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModals();
  });

  on(document.querySelector("#copy-id"), "click", copyKankaId, "#copy-id");
  on(document.querySelector("#logout-button"), "click", logout, "#logout-button");
  on(document.querySelector("#open-sidebar"), "click", () => {
    elements.roomSidebar?.classList.add("open");
  }, "#open-sidebar");
  on(document.querySelector("#close-sidebar"), "click", () => {
    elements.roomSidebar?.classList.remove("open");
  }, "#close-sidebar");
  on(document.querySelector("#toggle-members"), "click", () => {
    elements.membersPanel?.classList.toggle("open");
  }, "#toggle-members");
  on(elements.joinVoiceButton, "click", joinVoice, "#join-voice-button");
  on(elements.muteVoiceButton, "click", toggleVoiceMute, "#mute-voice-button");
  on(elements.toggleCameraButton, "click", toggleCamera, "#toggle-camera-button");
  on(elements.shareScreenButton, "click", toggleScreenShare, "#share-screen-button");
  on(elements.leaveVoiceButton, "click", () => leaveVoice(), "#leave-voice-button");
  on(elements.collapseVideoButton, "click", () => {
    state.voice.videoCollapsed = !state.voice.videoCollapsed;
    renderVideoStage();
  }, "#collapse-video-button");
  on(
    elements.googleFallbackButton,
    "click",
    showGooglePrompt,
    "#google-fallback-button",
  );
  on(
    elements.googleRetryButton,
    "click",
    retryGoogleLogin,
    "#google-retry-button",
  );
  on(document.querySelector("#open-profile-button"), "click", openOwnProfile, "#open-profile-button");
  on(document.querySelector("#settings-button"), "click", openSettings, "#settings-button");
  on(elements.profileForm, "submit", saveProfile, "#profile-form");
  on(elements.fileButton, "click", () => elements.fileInput?.click(), "#file-button");
  on(elements.fileInput, "change", handleFileSelection, "#file-input");
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    on(button, "click", () => saveTheme(button.dataset.themeChoice), "[data-theme-choice]");
  });
}

function showAuth() {
  elements.authView.classList.remove("hidden");
  elements.appView.classList.add("hidden");
  elements.googleButton.innerHTML = "";
  elements.googleFallbackButton.classList.add("hidden");
  elements.googleLoading.classList.remove("hidden");
  elements.setupWarning.classList.add("hidden");
  elements.googleError.classList.add("hidden");
  elements.devLogin.classList.toggle("hidden", !state.config?.allowDevLogin);

  if (!state.config?.googleConfigured || !state.config?.googleClientId) {
    elements.googleLoading.classList.add("hidden");
    elements.setupWarning.classList.remove("hidden");
    return;
  }

  setupGoogleButton();
}

async function setupGoogleButton() {
  try {
    await loadGoogleIdentityServices(8_000);
    window.google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
      use_fedcm_for_button: true,
    });
    window.google.accounts.id.renderButton(elements.googleButton, {
      type: "standard",
      theme: "filled_black",
      size: "large",
      shape: "rectangular",
      text: "continue_with",
      logo_alignment: "left",
      width: Math.min(elements.googleButton.clientWidth || 350, 350),
    });
    elements.googleLoading.classList.add("hidden");
    window.setTimeout(checkGoogleButtonHealth, 1_500);
  } catch (error) {
    showGoogleLoginError(
      "Google servisine ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene.",
    );
  }
}

function loadGoogleIdentityServices(timeoutMs = 8_000) {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;

  googleScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector("#google-identity-services");
    if (existingScript) existingScript.remove();

    const script = document.createElement("script");
    script.id = "google-identity-services";
    script.src = "https://accounts.google.com/gsi/client?hl=tr";
    script.async = true;
    script.defer = true;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback(value);
    };
    const timeout = window.setTimeout(() => {
      googleScriptPromise = null;
      finish(reject, new Error("Google Identity Services zaman aşımına uğradı."));
    }, timeoutMs);
    script.onload = () => {
      if (window.google?.accounts?.id) finish(resolve);
      else {
        googleScriptPromise = null;
        finish(reject, new Error("Google Identity Services başlatılamadı."));
      }
    };
    script.onerror = () => {
      googleScriptPromise = null;
      finish(reject, new Error("Google Identity Services yüklenemedi."));
    };
    document.head.append(script);
  });

  return googleScriptPromise;
}

async function checkGoogleButtonHealth() {
  if (!window.google?.accounts?.id) {
    showGoogleLoginError("Google giriş kütüphanesi başlatılamadı.");
    return;
  }

  const iframe = elements.googleButton.querySelector("iframe");
  if (!iframe) {
    showGoogleLoginError("Google giriş butonu oluşturulamadı.");
    return;
  }

  try {
    const statusUrl = new URL("https://accounts.google.com/gsi/status");
    statusUrl.searchParams.set("client_id", state.config.googleClientId);
    const response = await fetch(statusUrl, {
      credentials: "include",
      cache: "no-store",
    });
    if (response.status === 403) {
      const localhostOrigin = `${window.location.protocol}//${window.location.hostname}`;
      showGoogleLoginError(
        `Google Cloud'da Yetkili JavaScript kaynaklarına ${localhostOrigin} ve ${window.location.origin} eklenmeli.`,
      );
    }
  } catch {}
}

function showGoogleLoginError(message, keepButton = false) {
  elements.googleLoading.classList.add("hidden");
  elements.googleErrorMessage.textContent = message;
  elements.googleError.classList.remove("hidden");
  if (!keepButton || !elements.googleButton.querySelector("iframe")) {
    elements.googleButton.innerHTML = "";
    elements.googleFallbackButton.classList.remove("hidden");
  }
}

function showGooglePrompt() {
  if (!window.google?.accounts?.id) {
    retryGoogleLogin();
    return;
  }
  retryGoogleLogin();
}

async function retryGoogleLogin() {
  elements.googleError.classList.add("hidden");
  elements.googleFallbackButton.classList.add("hidden");
  elements.googleButton.innerHTML = "";
  elements.googleLoading.classList.remove("hidden");
  googleScriptPromise = null;
  document.querySelector("#google-identity-services")?.remove();
  await setupGoogleButton();
}

async function handleGoogleCredential(response) {
  if (!response?.credential) {
    showToast("Google giriş bilgisi alınamadı.", "error");
    return;
  }

  elements.googleButton.classList.add("is-busy");
  try {
    const result = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: response.credential }),
    });
    state.me = result.user;
    await enterApp();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.googleButton.classList.remove("is-busy");
  }
}

async function handleDevLogin(event) {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name");
  try {
    const result = await api("/api/auth/dev", {
      method: "POST",
      body: JSON.stringify({ name, key: name }),
    });
    state.me = result.user;
    await enterApp();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function enterApp() {
  const bootstrap = await api("/api/bootstrap");
  state.me = bootstrap.me;
  state.rooms = bootstrap.rooms;
  state.onlineUserIds = new Set(bootstrap.onlineUserIds);
  applyTheme(state.me.theme);

  if (!state.activeRoomId || !getActiveRoom()) {
    state.activeRoomId = state.rooms[0]?.id || null;
  }

  elements.authView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  renderProfile();
  renderRooms();
  renderVoiceControls();
  connectEvents();

  if (state.activeRoomId) {
    await selectRoom(state.activeRoomId);
  } else {
    renderEmptyState();
  }
}

function renderProfile() {
  elements.myKankaId.textContent = state.me.kankaId;
  elements.myName.textContent = state.me.name;
  elements.myStatus.innerHTML = "";
  const dot = document.createElement("i");
  dot.className = "status-dot";
  elements.myStatus.append(dot, document.createTextNode(
    state.me.statusMessage || "Çevrimiçi",
  ));
  renderAvatar(elements.myAvatar, state.me);
}

function applyTheme(theme) {
  const selectedTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === selectedTheme);
  });
}

function openOwnProfile() {
  if (!state.me) return;
  renderAvatar(elements.profileAvatar, state.me);
  elements.profileDisplayName.value = state.me.name;
  elements.profileStatus.value = state.me.statusMessage || "";
  elements.profileBio.value = state.me.bio || "";
  elements.profileGoogleInfo.textContent = `Google hesabı: ${state.me.googleName || state.me.name}`;
  elements.profileEmail.textContent = state.me.email || "";
  elements.profileKankaId.textContent = state.me.kankaId;
  openModal(elements.profileModal);
}

async function saveProfile(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: elements.profileDisplayName.value,
        statusMessage: elements.profileStatus.value,
        bio: elements.profileBio.value,
        theme: state.me.theme,
      }),
    });
    state.me = result.user;
    replaceUserEverywhere(result.user);
    renderProfile();
    renderMembers();
    renderMessages();
    closeModals();
    showToast("Profilin güncellendi.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function openUserProfile(user) {
  if (!user) return;
  if (user.id === state.me.id) {
    openOwnProfile();
    return;
  }
  renderAvatar(elements.viewProfileAvatar, user);
  elements.viewProfileName.textContent = user.name;
  elements.viewProfileStatus.textContent = user.statusMessage || "Çevrimiçi";
  elements.viewProfileBio.textContent = user.bio || "Henüz bio eklenmemiş.";
  elements.viewProfileKankaId.textContent = user.kankaId;
  openModal(elements.userProfileModal);
}

function openSettings() {
  applyTheme(state.me?.theme);
  openModal(elements.settingsModal);
}

async function saveTheme(theme) {
  if (!["dark", "light"].includes(theme) || !state.me) return;
  const previousTheme = state.me.theme;
  state.me.theme = theme;
  applyTheme(theme);
  try {
    await api("/api/settings/theme", {
      method: "PATCH",
      body: JSON.stringify({ theme }),
    });
    closeModals();
    showToast(theme === "light" ? "Açık tema etkin." : "Koyu tema etkin.");
  } catch (error) {
    state.me.theme = previousTheme;
    applyTheme(previousTheme);
    showToast(error.message, "error");
  }
}

function replaceUserEverywhere(user) {
  for (const room of state.rooms) {
    room.members = room.members.map((member) => (
      member.id === user.id ? { ...member, ...user } : member
    ));
  }
  state.messages = state.messages.map((message) => (
    message.userId === user.id
      ? { ...message, user: { ...message.user, ...user } }
      : message
  ));
  for (const participant of state.voice.participants.values()) {
    if (participant.user?.id === user.id) participant.user = { ...participant.user, ...user };
  }
}

function renderRooms() {
  elements.roomList.innerHTML = "";

  if (!state.rooms.length) {
    const empty = document.createElement("p");
    empty.className = "room-item";
    empty.textContent = "Henüz odan yok";
    elements.roomList.append(empty);
    return;
  }

  for (const room of state.rooms) {
    const button = document.createElement("button");
    button.className = `room-item${room.id === state.activeRoomId ? " active" : ""}`;
    button.type = "button";

    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = "#";
    const label = document.createElement("span");
    label.className = "room-label";
    label.textContent = room.name;
    button.append(hash, label);

    const unread = state.unread.get(room.id) || 0;
    if (unread) {
      const badge = document.createElement("span");
      badge.className = "unread";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      button.append(badge);
    }

    button.addEventListener("click", () => selectRoom(room.id));
    elements.roomList.append(button);
  }
}

async function selectRoom(roomId) {
  if (state.voice.roomId && state.voice.roomId !== roomId) {
    await leaveVoice({ silent: true });
  }
  state.activeRoomId = roomId;
  state.unread.delete(roomId);
  state.typing.clear();
  renderRooms();
  renderRoomHeader();
  renderMembers();
  elements.roomSidebar.classList.remove("open");

  elements.messages.innerHTML = '<div class="empty-room"><span class="spinner"></span></div>';
  try {
    const response = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`);
    if (state.activeRoomId !== roomId) return;
    state.messages = response.messages;
    renderMessages();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderRoomHeader() {
  const room = getActiveRoom();
  if (!room) return;
  elements.activeRoomName.textContent = room.name;
  elements.activeRoomSubtitle.textContent = `${room.members.length} üye · özel sohbet odası`;
  elements.inviteButton.classList.toggle("hidden", room.ownerId !== state.me.id);
  elements.messageInput.placeholder = `#${room.name} odasına mesaj gönder`;
  renderVoiceControls();
}

function renderMessages() {
  elements.messages.innerHTML = "";

  if (!state.messages.length) {
    const room = getActiveRoom();
    const empty = document.createElement("div");
    empty.className = "empty-room";
    empty.innerHTML = `
      <span class="empty-symbol">#</span>
      <h2>${escapeHtml(room?.name || "Yeni oda")}</h2>
      <p>Burası sohbetin başlangıcı. İlk mesajı gönder ve sessizliği boz.</p>
    `;
    elements.messages.append(empty);
    return;
  }

  let lastDate = "";
  let previousMessage = null;
  for (const message of state.messages) {
    const messageDate = new Date(message.createdAt);
    const dateKey = messageDate.toLocaleDateString("tr-TR");
    if (dateKey !== lastDate) {
      const divider = document.createElement("div");
      divider.className = "day-divider";
      divider.textContent = formatDay(messageDate);
      elements.messages.append(divider);
      lastDate = dateKey;
      previousMessage = null;
    }

    const compact = previousMessage
      && previousMessage.userId === message.userId
      && messageDate - new Date(previousMessage.createdAt) < 5 * 60 * 1000;
    elements.messages.append(createMessageElement(message, compact));
    previousMessage = message;
  }
  scrollMessagesToBottom(false);
}

function createMessageElement(message, compact = false) {
  const article = document.createElement("article");
  article.className = `message${message.userId === state.me.id ? " own" : ""}${compact ? " compact" : ""}`;
  article.dataset.messageId = message.id;

  const avatar = document.createElement("div");
  avatar.className = "avatar avatar-message message-user-action";
  avatar.tabIndex = 0;
  avatar.setAttribute("role", "button");
  avatar.setAttribute("aria-label", `${message.user.name} profilini aç`);
  renderAvatar(avatar, message.user);
  avatar.addEventListener("click", () => openUserProfile(message.user));
  avatar.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") openUserProfile(message.user);
  });

  const body = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = message.userId === state.me.id ? `${message.user.name} (sen)` : message.user.name;
  author.classList.add("message-user-action");
  author.addEventListener("click", () => openUserProfile(message.user));
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.createdAt;
  time.textContent = formatTime(new Date(message.createdAt));
  meta.append(author, time);

  const content = document.createElement("p");
  content.className = "message-text";
  content.textContent = message.content;
  body.append(meta);
  if (message.content) body.append(content);
  if (message.attachment) body.append(createAttachmentElement(message.attachment));
  article.append(avatar, body);
  return article;
}

function createAttachmentElement(attachment) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-attachment";
  const url = `/api/files/${encodeURIComponent(attachment.id)}`;

  if (attachment.isImage) {
    const link = document.createElement("a");
    link.className = "attachment-image-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    const image = document.createElement("img");
    image.className = "attachment-image";
    image.src = url;
    image.alt = attachment.originalName;
    image.loading = "lazy";
    link.append(image);
    wrapper.append(link);
    return wrapper;
  }

  const link = document.createElement("a");
  link.className = "attachment-file-card";
  link.href = url;
  link.download = attachment.originalName;
  const icon = document.createElement("span");
  icon.className = "attachment-file-icon";
  icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6M8 15h8M8 18h5"></path></svg>';
  const copy = document.createElement("span");
  copy.className = "attachment-file-copy";
  const name = document.createElement("strong");
  name.textContent = attachment.originalName;
  const details = document.createElement("span");
  details.textContent = `${fileExtensionLabel(attachment.originalName)} · ${formatBytes(attachment.size)}`;
  copy.append(name, details);
  link.append(icon, copy);
  wrapper.append(link);
  return wrapper;
}

function appendMessage(message) {
  if (state.messages.some((entry) => entry.id === message.id)) return;
  const wasNearBottom = isNearBottom();
  const empty = elements.messages.querySelector(".empty-room");
  if (empty) empty.remove();

  const previous = state.messages[state.messages.length - 1];
  const previousDate = previous ? new Date(previous.createdAt) : null;
  const messageDate = new Date(message.createdAt);
  if (!previousDate || previousDate.toLocaleDateString("tr-TR") !== messageDate.toLocaleDateString("tr-TR")) {
    const divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = formatDay(messageDate);
    elements.messages.append(divider);
  }
  const compact = previous
    && previous.userId === message.userId
    && messageDate - previousDate < 5 * 60 * 1000;
  state.messages.push(message);
  elements.messages.append(createMessageElement(message, compact));
  if (wasNearBottom || message.userId === state.me.id) scrollMessagesToBottom(true);
}

async function sendMessage(event) {
  event.preventDefault();
  const content = elements.messageInput.value.trim();
  if (!content || !state.activeRoomId) return;

  elements.messageInput.value = "";
  resizeComposer();
  elements.messageCount.textContent = "";

  try {
    const response = await api(`/api/rooms/${encodeURIComponent(state.activeRoomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    appendMessage(response.message);
  } catch (error) {
    elements.messageInput.value = content;
    resizeComposer();
    showToast(error.message, "error");
  }
}

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!state.activeRoomId) {
    showToast("Önce bir sohbet odası seç.", "error");
    return;
  }

  const extension = getFileExtension(file.name);
  const allowedMimeTypes = ALLOWED_FILE_TYPES.get(extension);
  const normalizedType = file.type || "application/octet-stream";
  if (!allowedMimeTypes || !allowedMimeTypes.includes(normalizedType)) {
    showToast("Bu dosya türü desteklenmiyor.", "error");
    return;
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    showToast("Dosya boyutu 10 MB veya daha küçük olmalı.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file, file.name);
  const caption = elements.messageInput.value.trim();
  if (caption) formData.append("caption", caption);

  elements.fileButton.disabled = true;
  elements.fileButton.title = "Dosya yükleniyor...";
  try {
    const response = await api(
      `/api/rooms/${encodeURIComponent(state.activeRoomId)}/uploads`,
      { method: "POST", body: formData },
    );
    if (caption) {
      elements.messageInput.value = "";
      resizeComposer();
    }
    appendMessage(response.message);
    showToast(`${response.message.attachment.originalName} gönderildi.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.fileButton.disabled = false;
    elements.fileButton.title = "Dosya gönder";
  }
}

function handleMessageInput() {
  resizeComposer();
  const length = elements.messageInput.value.length;
  elements.messageCount.textContent = length > 1600 ? `${length}/2000` : "";

  const now = Date.now();
  if (length && state.activeRoomId && now - state.lastTypingSentAt > 1800) {
    state.lastTypingSentAt = now;
    api(`/api/rooms/${encodeURIComponent(state.activeRoomId)}/typing`, {
      method: "POST",
      body: "{}",
    }).catch(() => {});
  }
}

function getFileExtension(filename) {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function fileExtensionLabel(filename) {
  return getFileExtension(filename).replace(".", "").toUpperCase() || "DOSYA";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 120)}px`;
}

function renderMembers() {
  const room = getActiveRoom();
  if (!room) return;
  elements.memberCount.textContent = String(room.members.length);
  elements.memberList.innerHTML = "";

  const members = [...room.members].sort((left, right) => {
    const onlineDiff = Number(state.onlineUserIds.has(right.id)) - Number(state.onlineUserIds.has(left.id));
    return onlineDiff || left.name.localeCompare(right.name, "tr");
  });

  for (const member of members) {
    const online = state.onlineUserIds.has(member.id);
    const item = document.createElement("div");
    item.className = `member-item${online ? "" : " offline"}`;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.addEventListener("click", () => openUserProfile(member));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openUserProfile(member);
    });
    const avatar = document.createElement("div");
    avatar.className = "avatar avatar-member";
    renderAvatar(avatar, member, online);

    const copy = document.createElement("div");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.id === state.me.id ? `${member.name} (sen)` : member.name;
    const status = document.createElement("span");
    const voiceParticipant = voiceParticipantForUser(member.id);
    status.textContent = voiceParticipant
      ? `Seste${voiceParticipant.muted ? " · Mikrofon kapalı" : ""}`
      : member.statusMessage || (online ? "Çevrimiçi" : "Çevrimdışı");
    copy.append(name, status);
    item.append(avatar, copy);
    elements.memberList.append(item);
  }
}

function renderAvatar(container, user, showOnline = false) {
  container.innerHTML = "";
  if (user.picture) {
    const image = document.createElement("img");
    image.src = user.picture;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    container.append(image);
  } else {
    container.textContent = initials(user.name);
  }
  if (showOnline) {
    const badge = document.createElement("span");
    badge.className = "online-badge";
    container.append(badge);
  }
}

const RTC_CONFIGURATION = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function connectVoiceSocket() {
  const currentSocket = state.voice.socket;
  if (currentSocket?.readyState === WebSocket.OPEN) return Promise.resolve(currentSocket);
  if (currentSocket?.readyState === WebSocket.CONNECTING && state.voice.socketPromise) {
    return state.voice.socketPromise;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.voice.socket = socket;
  state.voice.socketPromise = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Ses sunucusuna bağlanılamadı."));
      }
    }, { once: true });
  });

  socket.addEventListener("message", handleVoiceSocketMessage);
  socket.addEventListener("close", () => {
    const wasConnected = state.voice.joined || state.voice.joining;
    state.voice.socket = null;
    state.voice.socketPromise = null;
    cleanupVoiceMedia();
    if (wasConnected && state.me) {
      showToast("Ses bağlantısı kapandı.", "error");
    }
  });
  return state.voice.socketPromise;
}

async function joinVoice() {
  if (!state.activeRoomId || state.voice.joined || state.voice.joining) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    showToast("Tarayıcın WebRTC sesli sohbeti desteklemiyor.", "error");
    return;
  }

  const requestedRoomId = state.activeRoomId;
  state.voice.joining = true;
  state.voice.roomId = requestedRoomId;
  renderVoiceControls();

  try {
    state.voice.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const socket = await connectVoiceSocket();
    if (state.activeRoomId !== requestedRoomId) {
      await leaveVoice({ silent: true });
      return;
    }
    sendVoiceSocket({
      type: "join-voice",
      roomId: requestedRoomId,
    });

    setTimeout(() => {
      if (state.voice.joining && state.voice.roomId === requestedRoomId) {
        cleanupVoiceMedia();
        showToast("Ses odasına bağlanma zaman aşımına uğradı.", "error");
      }
    }, 10_000);
  } catch (error) {
    cleanupVoiceMedia();
    const denied = error?.name === "NotAllowedError";
    showToast(
      denied ? "Sesli sohbet için mikrofon izni gerekiyor." : error.message,
      "error",
    );
  }
}

function sendVoiceSocket(payload) {
  if (state.voice.socket?.readyState === WebSocket.OPEN) {
    state.voice.socket.send(JSON.stringify(payload));
  }
}

async function handleVoiceSocketMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  try {
    if (message.type === "voice-joined") {
      if (message.roomId !== state.activeRoomId) {
        sendVoiceSocket({ type: "leave-voice" });
        cleanupVoiceMedia();
        return;
      }
      state.voice.joined = true;
      state.voice.joining = false;
      state.voice.roomId = message.roomId;
      state.voice.selfPeerId = message.peerId;
      state.voice.participants.clear();
      state.voice.participants.set(message.peerId, {
        peerId: message.peerId,
        user: state.me,
        muted: false,
        cameraEnabled: state.voice.cameraEnabled,
        screenSharing: state.voice.screenSharing,
      });
      for (const peer of message.peers || []) {
        state.voice.participants.set(peer.peerId, peer);
      }
      renderVoiceControls();
      renderMembers();
      renderVideoStage();

      for (const peer of message.peers || []) {
        await createVoiceOffer(peer);
      }
      return;
    }

    if (message.roomId && message.roomId !== state.voice.roomId) return;

    if (message.type === "voice-peer-joined") {
      state.voice.participants.set(message.peer.peerId, message.peer);
      renderVoiceControls();
      renderMembers();
      renderVideoStage();
      return;
    }
    if (message.type === "voice-peer-left") {
      state.voice.participants.delete(message.peerId);
      removeVoicePeer(message.peerId);
      renderVoiceControls();
      renderMembers();
      renderVideoStage();
      return;
    }
    if (message.type === "voice-presence") {
      state.voice.participants = new Map(
        (message.participants || []).map((peer) => [peer.peerId, peer]),
      );
      renderVoiceControls();
      renderMembers();
      renderVideoStage();
      return;
    }
    if (message.type === "voice-peer-muted") {
      const peer = state.voice.participants.get(message.peerId);
      if (peer) peer.muted = Boolean(message.muted);
      renderMembers();
      renderVideoStage();
      return;
    }
    if (message.type === "voice-peer-media") {
      const peer = state.voice.participants.get(message.peerId);
      if (peer) {
        peer.cameraEnabled = Boolean(message.cameraEnabled);
        peer.screenSharing = Boolean(message.screenSharing);
      }
      renderMembers();
      renderVideoStage();
      return;
    }
    if (message.type === "webrtc-offer") {
      await acceptVoiceOffer(message);
      return;
    }
    if (message.type === "webrtc-answer") {
      const peer = ensureVoicePeer(message.fromPeerId, message.user);
      await peer.connection.setRemoteDescription(message.sdp);
      await flushVoiceCandidates(peer);
      return;
    }
    if (message.type === "webrtc-ice-candidate" && message.candidate) {
      const peer = ensureVoicePeer(message.fromPeerId, message.user);
      if (peer.connection.remoteDescription) {
        await peer.connection.addIceCandidate(message.candidate);
      } else {
        peer.pendingCandidates.push(message.candidate);
      }
      return;
    }
    if (message.type === "voice-error") {
      cleanupVoiceMedia();
      showToast(message.message || "Ses bağlantısı kurulamadı.", "error");
    }
  } catch (error) {
    showToast("Ses bağlantısı kurulurken hata oluştu.", "error");
  }
}

function ensureVoicePeer(peerId, user) {
  const existing = state.voice.peers.get(peerId);
  if (existing) {
    if (user) existing.user = user;
    return existing;
  }

  const connection = new RTCPeerConnection(RTC_CONFIGURATION);
  const peer = {
    peerId,
    user,
    connection,
    pendingCandidates: [],
    audio: null,
    remoteStream: new MediaStream(),
    videoSender: null,
  };
  state.voice.peers.set(peerId, peer);

  for (const track of state.voice.localStream?.getTracks() || []) {
    connection.addTrack(track, state.voice.localStream);
  }
  const outgoingVideoTrack = currentOutgoingVideoTrack();
  if (outgoingVideoTrack) {
    const outgoingStream = currentOutgoingVideoStream();
    peer.videoSender = connection.addTrack(outgoingVideoTrack, outgoingStream);
  }

  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    sendVoiceSocket({
      type: "webrtc-ice-candidate",
      targetPeerId: peerId,
      candidate: event.candidate,
    });
  });

  connection.addEventListener("track", (event) => {
    if (event.track.kind === "video") {
      for (const oldTrack of peer.remoteStream.getVideoTracks()) {
        peer.remoteStream.removeTrack(oldTrack);
      }
      peer.remoteStream.addTrack(event.track);
      event.track.addEventListener("unmute", renderVideoStage);
      event.track.addEventListener("mute", renderVideoStage);
      event.track.addEventListener("ended", renderVideoStage, { once: true });
      renderVideoStage();
      return;
    }
    if (!peer.audio) {
      peer.audio = document.createElement("audio");
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      peer.audio.dataset.peerId = peerId;
      elements.voiceAudioRoot.append(peer.audio);
    }
    peer.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    peer.audio.play().catch(() => {
      showToast("Uzak sesi oynatmak için sayfaya bir kez tıkla.", "error");
    });
  });

  connection.addEventListener("connectionstatechange", () => {
    if (["failed", "closed"].includes(connection.connectionState)) {
      removeVoicePeer(peerId);
    }
  });
  return peer;
}

async function createVoiceOffer(peerInfo) {
  const peer = ensureVoicePeer(peerInfo.peerId, peerInfo.user);
  const offer = await peer.connection.createOffer();
  await peer.connection.setLocalDescription(offer);
  sendVoiceSocket({
    type: "webrtc-offer",
    targetPeerId: peerInfo.peerId,
    sdp: peer.connection.localDescription,
  });
}

async function acceptVoiceOffer(message) {
  const peer = ensureVoicePeer(message.fromPeerId, message.user);
  await peer.connection.setRemoteDescription(message.sdp);
  await flushVoiceCandidates(peer);
  const answer = await peer.connection.createAnswer();
  await peer.connection.setLocalDescription(answer);
  sendVoiceSocket({
    type: "webrtc-answer",
    targetPeerId: message.fromPeerId,
    sdp: peer.connection.localDescription,
  });
}

async function flushVoiceCandidates(peer) {
  for (const candidate of peer.pendingCandidates.splice(0)) {
    await peer.connection.addIceCandidate(candidate);
  }
}

function removeVoicePeer(peerId) {
  const peer = state.voice.peers.get(peerId);
  if (!peer) return;
  peer.connection.close();
  peer.audio?.remove();
  state.voice.peers.delete(peerId);
  renderVideoStage();
}

function closeAllVoicePeers() {
  for (const peerId of [...state.voice.peers.keys()]) {
    removeVoicePeer(peerId);
  }
  elements.voiceAudioRoot.innerHTML = "";
}

function currentOutgoingVideoTrack() {
  if (state.voice.screenSharing) {
    return state.voice.screenStream?.getVideoTracks()[0] || null;
  }
  if (state.voice.cameraEnabled) {
    return state.voice.cameraStream?.getVideoTracks()[0] || null;
  }
  return null;
}

function currentOutgoingVideoStream() {
  if (state.voice.screenSharing) return state.voice.screenStream;
  if (state.voice.cameraEnabled) return state.voice.cameraStream;
  return null;
}

async function replaceOutgoingVideoTrack(track) {
  for (const peer of state.voice.peers.values()) {
    if (peer.videoSender) {
      await peer.videoSender.replaceTrack(track || null);
      continue;
    }
    if (!track) continue;
    peer.videoSender = peer.connection.addTrack(track, currentOutgoingVideoStream());
    await createVoiceOffer(peer);
  }
}

function updateLocalMediaState() {
  const participant = state.voice.participants.get(state.voice.selfPeerId);
  if (participant) {
    participant.cameraEnabled = state.voice.cameraEnabled;
    participant.screenSharing = state.voice.screenSharing;
  }
  sendVoiceSocket({
    type: "voice-media-state",
    cameraEnabled: state.voice.cameraEnabled,
    screenSharing: state.voice.screenSharing,
  });
  renderVoiceControls();
  renderMembers();
  renderVideoStage();
}

async function toggleCamera() {
  if (!state.voice.joined) return;
  if (state.voice.cameraEnabled) {
    await stopCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Tarayıcın kamera kullanımını desteklemiyor.", "error");
    return;
  }

  elements.toggleCameraButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track || !state.voice.joined) {
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
      return;
    }
    state.voice.cameraStream = stream;
    state.voice.cameraEnabled = true;
    track.addEventListener("ended", handleCameraEnded, { once: true });
    if (!state.voice.screenSharing) await replaceOutgoingVideoTrack(track);
    updateLocalMediaState();
  } catch (error) {
    const denied = error?.name === "NotAllowedError";
    showToast(
      denied ? "Kamerayı açmak için kamera izni gerekiyor." : "Kamera açılamadı.",
      "error",
    );
  } finally {
    elements.toggleCameraButton.disabled = false;
  }
}

async function handleCameraEnded() {
  if (!state.voice.cameraEnabled) return;
  state.voice.cameraEnabled = false;
  state.voice.cameraStream = null;
  if (!state.voice.screenSharing) await replaceOutgoingVideoTrack(null);
  updateLocalMediaState();
}

async function stopCamera() {
  const stream = state.voice.cameraStream;
  state.voice.cameraStream = null;
  state.voice.cameraEnabled = false;
  for (const track of stream?.getTracks() || []) {
    track.removeEventListener("ended", handleCameraEnded);
    track.stop();
  }
  if (!state.voice.screenSharing) await replaceOutgoingVideoTrack(null);
  updateLocalMediaState();
}

async function toggleScreenShare() {
  if (!state.voice.joined) return;
  if (state.voice.screenSharing) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Tarayıcın ekran paylaşımını desteklemiyor.", "error");
    return;
  }

  elements.shareScreenButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 24, max: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track || !state.voice.joined) {
      for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
      return;
    }
    state.voice.screenStream = stream;
    state.voice.screenSharing = true;
    track.addEventListener("ended", handleScreenShareEnded, { once: true });
    await replaceOutgoingVideoTrack(track);
    updateLocalMediaState();
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      showToast("Ekran paylaşımı başlatılamadı.", "error");
    }
  } finally {
    elements.shareScreenButton.disabled = false;
  }
}

function handleScreenShareEnded() {
  stopScreenShare({ trackAlreadyEnded: true }).catch(() => {});
}

async function stopScreenShare({ trackAlreadyEnded = false } = {}) {
  if (!state.voice.screenSharing && !state.voice.screenStream) return;
  const stream = state.voice.screenStream;
  state.voice.screenStream = null;
  state.voice.screenSharing = false;
  for (const track of stream?.getTracks() || []) {
    track.removeEventListener("ended", handleScreenShareEnded);
    if (!trackAlreadyEnded) track.stop();
  }
  await replaceOutgoingVideoTrack(
    state.voice.cameraEnabled
      ? state.voice.cameraStream?.getVideoTracks()[0] || null
      : null,
  );
  updateLocalMediaState();
}

function renderVideoStage() {
  const activeInRoom = state.voice.joined && state.voice.roomId === state.activeRoomId;
  elements.videoStage.classList.toggle("hidden", !activeInRoom);
  elements.videoStage.classList.toggle("collapsed", state.voice.videoCollapsed);
  elements.collapseVideoButton.setAttribute(
    "aria-label",
    state.voice.videoCollapsed ? "Görüntüleri büyüt" : "Görüntüleri küçült",
  );
  if (!activeInRoom) {
    elements.videoGrid.innerHTML = "";
    return;
  }

  const participants = [...state.voice.participants.values()];
  elements.videoStageStatus.textContent = `${participants.length} katılımcı`;
  elements.videoGrid.innerHTML = "";

  for (const participant of participants) {
    const isLocal = participant.peerId === state.voice.selfPeerId;
    const peer = isLocal ? null : state.voice.peers.get(participant.peerId);
    const stream = isLocal
      ? state.voice.screenSharing
        ? state.voice.screenStream
        : state.voice.cameraStream
      : peer?.remoteStream;
    const mediaActive = participant.screenSharing || participant.cameraEnabled;
    const tile = document.createElement("article");
    tile.className = `video-tile${participant.screenSharing ? " sharing-screen" : ""}`;

    if (mediaActive && stream?.getVideoTracks().length) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      video.className = isLocal && !participant.screenSharing ? "mirrored" : "";
      video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), {
        once: true,
      });
      tile.append(video);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "video-placeholder";
      const avatar = document.createElement("div");
      avatar.className = "avatar video-avatar";
      renderAvatar(avatar, participant.user);
      const message = document.createElement("span");
      message.textContent = participant.cameraEnabled ? "Görüntü bekleniyor" : "Kamera kapalı";
      placeholder.append(avatar, message);
      tile.append(placeholder);
    }

    const footer = document.createElement("div");
    footer.className = "video-tile-footer";
    const name = document.createElement("strong");
    name.textContent = isLocal ? `${participant.user.name} (sen)` : participant.user.name;
    const stateLabel = document.createElement("span");
    stateLabel.textContent = participant.screenSharing
      ? "Ekran paylaşıyor"
      : participant.muted
        ? "Mikrofon kapalı"
        : "Mikrofon açık";
    footer.append(name, stateLabel);
    tile.append(footer);
    elements.videoGrid.append(tile);
  }
}

function toggleVoiceMute() {
  if (!state.voice.joined || !state.voice.localStream) return;
  state.voice.muted = !state.voice.muted;
  for (const track of state.voice.localStream.getAudioTracks()) {
    track.enabled = !state.voice.muted;
  }
  sendVoiceSocket({
    type: "voice-mute-state",
    muted: state.voice.muted,
  });
  renderVoiceControls();
}

async function leaveVoice({ silent = false } = {}) {
  if (state.voice.joined || state.voice.joining) {
    sendVoiceSocket({ type: "leave-voice" });
  }
  cleanupVoiceMedia();
  if (!silent) showToast("Sesli sohbetten ayrıldın.");
}

function cleanupVoiceMedia() {
  const cameraStream = state.voice.cameraStream;
  const screenStream = state.voice.screenStream;
  state.voice.cameraStream = null;
  state.voice.screenStream = null;
  state.voice.cameraEnabled = false;
  state.voice.screenSharing = false;
  for (const track of state.voice.localStream?.getTracks() || []) track.stop();
  for (const track of cameraStream?.getTracks() || []) track.stop();
  for (const track of screenStream?.getTracks() || []) track.stop();
  state.voice.localStream = null;
  closeAllVoicePeers();
  state.voice.participants.clear();
  state.voice.roomId = null;
  state.voice.selfPeerId = null;
  state.voice.joined = false;
  state.voice.joining = false;
  state.voice.muted = false;
  renderVoiceControls();
  renderVideoStage();
  if (state.me) renderMembers();
}

function voiceParticipantForUser(userId) {
  return [...state.voice.participants.values()].find((peer) => peer.user?.id === userId);
}

function renderVoiceControls() {
  const activeInRoom = state.voice.joined && state.voice.roomId === state.activeRoomId;
  const joiningRoom = state.voice.joining && state.voice.roomId === state.activeRoomId;
  elements.joinVoiceButton.classList.toggle("hidden", activeInRoom);
  elements.joinVoiceButton.disabled = joiningRoom || !state.activeRoomId;
  elements.joinVoiceButton.querySelector("span").textContent = joiningRoom
    ? "Bağlanıyor..."
    : "Sese Katıl";
  elements.muteVoiceButton.classList.toggle("hidden", !activeInRoom);
  elements.toggleCameraButton.classList.toggle("hidden", !activeInRoom);
  elements.shareScreenButton.classList.toggle("hidden", !activeInRoom);
  elements.leaveVoiceButton.classList.toggle("hidden", !activeInRoom);
  elements.muteVoiceButton.classList.toggle("active", activeInRoom && !state.voice.muted);
  elements.toggleCameraButton.classList.toggle(
    "active",
    activeInRoom && state.voice.cameraEnabled,
  );
  elements.shareScreenButton.classList.toggle(
    "sharing",
    activeInRoom && state.voice.screenSharing,
  );
  elements.toggleCameraButton.querySelector("span").textContent = state.voice.cameraEnabled
    ? "Kamerayı Kapat"
    : "Kamerayı Aç";
  elements.toggleCameraButton.setAttribute(
    "aria-label",
    state.voice.cameraEnabled ? "Kamerayı kapat" : "Kamerayı aç",
  );
  elements.shareScreenButton.querySelector("span").textContent = state.voice.screenSharing
    ? "Paylaşımı Durdur"
    : "Ekranı Paylaş";
  elements.shareScreenButton.setAttribute(
    "aria-label",
    state.voice.screenSharing
      ? "Ekran paylaşımını durdur"
      : "Ekran paylaşımını başlat",
  );
  elements.muteVoiceButton.querySelector("span").textContent = state.voice.muted
    ? "Mikrofonu Aç"
    : "Mikrofonu Kapat";
  elements.muteVoiceButton.setAttribute(
    "aria-label",
    state.voice.muted ? "Mikrofonu aç" : "Mikrofonu kapat",
  );

  if (joiningRoom) {
    elements.voiceStatus.textContent = "Bağlanıyor";
  } else if (activeInRoom) {
    const count = state.voice.participants.size;
    elements.voiceStatus.textContent = count > 1 ? `Seste ${count} kişi` : "Seste yalnızsın";
  } else {
    elements.voiceStatus.textContent = "";
  }
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource("/api/events");
  state.eventSource = source;

  source.addEventListener("chat-message", (event) => {
    const message = JSON.parse(event.data);
    if (message.roomId === state.activeRoomId) {
      appendMessage(message);
    } else {
      state.unread.set(message.roomId, (state.unread.get(message.roomId) || 0) + 1);
      renderRooms();
    }
  });

  source.addEventListener("presence", (event) => {
    const payload = JSON.parse(event.data);
    state.onlineUserIds = new Set(payload.onlineUserIds);
    renderMembers();
  });

  source.addEventListener("rooms-updated", async () => {
    await refreshRooms();
  });

  source.addEventListener("profile-updated", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.user.id === state.me.id) {
      state.me = { ...state.me, ...payload.user };
      renderProfile();
    }
    replaceUserEverywhere(payload.user);
    renderMembers();
    renderMessages();
  });

  source.addEventListener("typing", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.roomId !== state.activeRoomId || payload.user.id === state.me.id) return;
    state.typing.set(payload.user.id, { user: payload.user, expiresAt: Date.now() + 2800 });
    renderTyping();
  });
}

async function refreshRooms() {
  try {
    const bootstrap = await api("/api/bootstrap");
    state.rooms = bootstrap.rooms;
    state.onlineUserIds = new Set(bootstrap.onlineUserIds);
    if (!getActiveRoom()) {
      if (state.voice.roomId) await leaveVoice({ silent: true });
      state.activeRoomId = state.rooms[0]?.id || null;
    }
    renderRooms();
    renderRoomHeader();
    renderMembers();
    renderVoiceControls();
    if (state.activeRoomId && !state.messages.length) await selectRoom(state.activeRoomId);
  } catch (error) {
    if (error.status === 401) showAuthAfterLogout();
  }
}

function renderTyping() {
  const active = [...state.typing.values()].filter((entry) => entry.expiresAt > Date.now());
  for (const [userId, entry] of state.typing) {
    if (entry.expiresAt <= Date.now()) state.typing.delete(userId);
  }

  if (!active.length) {
    elements.typingIndicator.textContent = "";
    return;
  }
  const names = active.slice(0, 2).map((entry) => entry.user.name).join(" ve ");
  elements.typingIndicator.textContent = `${names} yazıyor...`;
  setTimeout(renderTyping, 900);
}

async function createRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const name = new FormData(form).get("name");
  button.disabled = true;
  try {
    const response = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    form.reset();
    closeModals();
    await refreshRooms();
    await selectRoom(response.room.id);
    showToast(`${response.room.name} odası oluşturuldu.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function inviteFriend(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const kankaId = String(new FormData(form).get("kankaId")).trim().toUpperCase();
  if (!state.activeRoomId) return;
  button.disabled = true;

  try {
    const response = await api(`/api/rooms/${encodeURIComponent(state.activeRoomId)}/invites`, {
      method: "POST",
      body: JSON.stringify({ kankaId }),
    });
    form.reset();
    closeModals();
    await refreshRooms();
    showToast(`${response.invitedUser.name} odaya eklendi.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function copyKankaId() {
  try {
    await navigator.clipboard.writeText(state.me.kankaId);
    showToast("Kanka ID panoya kopyalandı.");
  } catch {
    showToast(`Kanka ID: ${state.me.kankaId}`);
  }
}

async function logout() {
  try {
    await leaveVoice({ silent: true });
    state.voice.socket?.close();
    await api("/api/logout", { method: "POST", body: "{}" });
  } finally {
    showAuthAfterLogout();
  }
}

function showAuthAfterLogout() {
  state.eventSource?.close();
  cleanupVoiceMedia();
  state.voice.socket?.close();
  state.voice.socket = null;
  state.voice.socketPromise = null;
  state.eventSource = null;
  state.me = null;
  state.rooms = [];
  state.messages = [];
  state.activeRoomId = null;
  window.location.reload();
}

function openModal(modal) {
  if (!modal) return;
  closeModals();
  elements.modalBackdrop.classList.remove("hidden");
  modal.classList.remove("hidden");
}

function closeModals() {
  elements.modalBackdrop.classList.add("hidden");
  [
    elements.createRoomModal,
    elements.inviteModal,
    elements.profileModal,
    elements.userProfileModal,
    elements.settingsModal,
  ].forEach((modal) => modal?.classList.add("hidden"));
}

function getActiveRoom() {
  return state.rooms.find((room) => room.id === state.activeRoomId);
}

function renderEmptyState() {
  elements.activeRoomName.textContent = "Bir oda oluştur";
  elements.activeRoomSubtitle.textContent = "Sohbete başlamak için ilk odanı kur";
  elements.messages.innerHTML = `
    <div class="empty-room">
      <span class="empty-symbol">+</span>
      <h2>Henüz sohbet odan yok</h2>
      <p>Sol menüdeki artı düğmesine basarak ilk özel odanı oluştur.</p>
    </div>
  `;
  elements.inviteButton.classList.add("hidden");
  renderVoiceControls();
}

function scrollMessagesToBottom(smooth = true) {
  requestAnimationFrame(() => {
    elements.messages.scrollTo({
      top: elements.messages.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  });
}

function isNearBottom() {
  const distance = elements.messages.scrollHeight
    - elements.messages.scrollTop
    - elements.messages.clientHeight;
  return distance < 120;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDay(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Bugün";
  if (date.toDateString() === yesterday.toDateString()) return "Dün";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  }).format(date);
}

function initials(name = "?") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("tr-TR"))
    .join("");
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value);
  return element.innerHTML;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.querySelector("#toast-root").append(toast);
  setTimeout(() => toast.remove(), 3600);
}
