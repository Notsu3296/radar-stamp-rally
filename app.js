const CSV_PATH = "locations.csv";
const STORAGE_KEY = "location-game-visits";
const RADAR_RANGES = {
  detail: 100,
  normal: 1000,
  wide: 5000,
};
const RADAR_RANGE_ORDER = ["detail", "normal", "wide"];
const RADAR_RANGE_LABELS = {
  detail: "詳細",
  normal: "通常",
  wide: "広域",
};
const RADAR_DOT_VISIBLE_MS = 10000;
const RADAR_DOT_FADE_MS = 5000;
const RADAR_REFRESH_MS = 5000;
const DEBUG_HEADING = false;
const USE_SCREEN_ANGLE_COMPENSATION = false;
const HEADING_DISPLAY_OFFSET_DEGREES = 0;
const state = {
  locations: [],
  visits: loadVisits(),
  currentPosition: null,
  latestPosition: null,
  positionWatchId: null,
  positionRefreshTimerId: null,
  heading: null,
  lockedHeading: null,
  radarDotsVisible: false,
  radarDotsFading: false,
  radarDotTimerId: null,
  radarDotFadeTimerId: null,
  lastRawWebkitCompassHeading: null,
  lastRawAlpha: null,
  lastEventAbsolute: null,
  lastScreenAngle: 0,
  lastNormalizedHeading: null,
  orientationSamples: [],
  orientationSampleStartedAt: null,
  orientationListening: false,
  orientationEventName: null,
  showLabels: false,
  radarRangeMode: "normal",
  pendingRadarRangeMode: null,
  categoryColors: new Map(),
  visibleCategories: new Set(),
  activeDetailSection: null,
  qrStream: null,
  qrScanFrameId: null,
  qrDetector: null,
  qrScanLocked: false,
};

const elements = {
  radarMarkers: document.querySelector("#radarMarkers"),
  radarSweep: document.querySelector(".radar-sweep"),
  radar: document.querySelector("#radar"),
  compassLabels: document.querySelector("#compassLabels"),
  menuButton: document.querySelector("#menuButton"),
  closeMenuButton: document.querySelector("#closeMenuButton"),
  actionPanel: document.querySelector("#actionPanel"),
  menuBackdrop: document.querySelector("#menuBackdrop"),
  qrScanButton: document.querySelector("#qrScanButton"),
  locateIconButton: document.querySelector("#locateIconButton"),
  menuItemButtons: document.querySelectorAll("[data-detail]"),
  detailPanel: document.querySelector("#detailPanel"),
  detailBackdrop: document.querySelector("#detailBackdrop"),
  closeDetailButton: document.querySelector("#closeDetailButton"),
  detailTitle: document.querySelector("#detailTitle"),
  detailBody: document.querySelector("#detailBody"),
  rangeSlider: document.querySelector("#rangeSlider"),
  rangeModeLabel: document.querySelector("#rangeModeLabel"),
  gpsAccuracyBadge: document.querySelector("#gpsAccuracyBadge"),
  qrNotice: null,
  locationSummary: null,
  radarHint: null,
  visitActions: null,
};

init();

async function init() {
  ensureStatusElements();
  bindEvents();
  startOrientationTracking();

  try {
    state.locations = await loadLocations();
    state.visibleCategories = new Set(state.locations.map((location) => location.category));
    await handleQrVisit();
    render();
    startPositionTracking();
  } catch (error) {
    elements.locationSummary.textContent = error.message;
    elements.locationSummary.classList.remove("hidden");
    render();
  }
}

function bindEvents() {
  elements.menuButton.addEventListener("click", toggleMenu);
  elements.qrScanButton.addEventListener("click", openQrScanner);
  elements.locateIconButton.addEventListener("click", updateCurrentLocation);
  elements.closeMenuButton.addEventListener("click", closeMenu);
  elements.menuBackdrop.addEventListener("click", closeMenu);
  elements.closeDetailButton.addEventListener("click", closeDetailPanel);
  elements.detailBackdrop.addEventListener("click", closeDetailPanel);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      closeDetailPanel();
    }
  });

  elements.menuItemButtons.forEach((button) => {
    button.addEventListener("click", () => {
      openDetailPanel(button.dataset.detail);
      closeMenu();
    });
  });

  elements.rangeSlider.addEventListener("input", () => {
    setRadarRange(RADAR_RANGE_ORDER[Number(elements.rangeSlider.value)]);
  });
}

function toggleMenu() {
  if (elements.actionPanel.classList.contains("is-open")) {
    closeMenu();
  } else {
    openMenu();
  }
}

function openMenu() {
  elements.actionPanel.classList.add("is-open");
  elements.menuBackdrop.hidden = false;
  elements.menuButton.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  elements.actionPanel.classList.remove("is-open");
  elements.menuBackdrop.hidden = true;
  elements.menuButton.setAttribute("aria-expanded", "false");
}

function setRadarRange(mode) {
  if (!RADAR_RANGES[mode]) return;

  state.radarRangeMode = mode;
  elements.rangeSlider.value = String(RADAR_RANGE_ORDER.indexOf(mode));
  elements.rangeModeLabel.textContent = RADAR_RANGE_LABELS[mode];
  render();
  pulseRadar();
}

function openDetailPanel(section) {
  state.activeDetailSection = section;
  renderDetailPanel(section);
  elements.detailPanel.classList.remove("hidden");
  elements.detailBackdrop.hidden = false;
}

function closeDetailPanel() {
  stopQrScanner();
  state.activeDetailSection = null;
  elements.detailPanel.classList.add("hidden");
  elements.detailBackdrop.hidden = true;
}

function renderDetailPanel(section) {
  elements.detailBody.replaceChildren();

  if (section === "guide") {
    elements.detailTitle.textContent = "楽しみ方";
    renderGuideDetail();
  } else if (section === "category") {
    elements.detailTitle.textContent = "カテゴリ表示";
    renderCategoryDetail();
  } else if (section === "labels") {
    elements.detailTitle.textContent = "地点名表示";
    renderLabelsDetail();
  } else if (section === "history") {
    elements.detailTitle.textContent = "地点履歴";
    renderHistoryDetail();
  } else if (section === "reset") {
    elements.detailTitle.textContent = "履歴リセット";
    renderResetDetail();
  }
}

async function openQrScanner() {
  stopQrScanner();
  openDetailPanel("qr");
  elements.detailTitle.textContent = "QRチェックイン";
  renderQrScannerDetail("カメラを起動しています...");

  if (!navigator.mediaDevices?.getUserMedia) {
    renderQrScannerError("このブラウザではカメラを起動できません。QRコードURLを直接開いてチェックインしてください。");
    return;
  }

  if (!("BarcodeDetector" in window)) {
    renderQrScannerError("このブラウザはQRコード解析に対応していません。ChromeなどBarcodeDetector対応ブラウザでお試しください。");
    return;
  }

  try {
    state.qrDetector = state.qrDetector ?? new BarcodeDetector({ formats: ["qr_code"] });
    state.qrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });

    renderQrScannerDetail("QRコードをカメラに写してください。");
    const video = elements.detailBody.querySelector("#qrVideo");
    video.srcObject = state.qrStream;
    await video.play();
    state.qrScanLocked = false;
    scanQrFrame(video);
  } catch (error) {
    renderQrScannerError(getCameraErrorMessage(error));
  }
}

function renderQrScannerDetail(message) {
  elements.detailBody.replaceChildren();

  const scanner = document.createElement("div");
  scanner.className = "qr-scanner";

  const video = document.createElement("video");
  video.id = "qrVideo";
  video.className = "qr-video";
  video.setAttribute("playsinline", "");
  video.muted = true;

  const frame = document.createElement("div");
  frame.className = "qr-frame";
  frame.append(video);

  const status = document.createElement("p");
  status.className = "detail-note qr-status";
  status.textContent = message;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary-button";
  retry.textContent = "カメラを再起動";
  retry.addEventListener("click", openQrScanner);

  scanner.append(frame, status, retry);
  elements.detailBody.append(scanner);
}

function renderQrScannerError(message) {
  stopQrScanner();
  elements.detailBody.replaceChildren();

  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = message;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary-button";
  retry.textContent = "もう一度読み取る";
  retry.addEventListener("click", openQrScanner);

  elements.detailBody.append(note, retry);
}

async function scanQrFrame(video) {
  if (!state.qrStream || state.qrScanLocked) return;

  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const codes = await state.qrDetector.detect(video);
      const code = codes.find((item) => item.rawValue);

      if (code) {
        state.qrScanLocked = true;
        handleScannedQrValue(code.rawValue);
        return;
      }
    }
  } catch {
    // 一時的に読み取れないフレームは無視して、次のフレームで再試行します。
  }

  state.qrScanFrameId = requestAnimationFrame(() => scanQrFrame(video));
}

function handleScannedQrValue(rawValue) {
  const uuid = extractUuidFromQrValue(rawValue);

  if (!uuid) {
    renderQrScannerError("QRコードからUUIDを読み取れませんでした。このアプリ用のQRコードか確認してください。");
    return;
  }

  const location = findLocationByUuid(uuid);
  if (!location) {
    renderQrScannerError("QRコードのUUIDに一致する地点が見つかりませんでした。CSVのUUIDと一致しているか確認してください。");
    return;
  }

  const wasVisited = isVisited(location.id);
  recordVisit(location);
  render();
  showCheckinDetail(location, wasVisited, "radar");
}

function extractUuidFromQrValue(rawValue) {
  const value = rawValue.trim();

  try {
    const url = new URL(value, window.location.href);
    const uuid = url.searchParams.get("uuid");
    if (uuid) return uuid;
  } catch {
    // URLではなくUUID単体が入っているQRコードも許容します。
  }

  return value || null;
}

function findLocationByUuid(uuid) {
  return state.locations.find((item) => item.id.toLowerCase() === uuid.toLowerCase());
}

function showCheckinDetail(location, wasVisited = false, returnTo = "radar") {
  stopQrScanner();
  state.activeDetailSection = "checkin";
  elements.detailTitle.textContent = wasVisited ? "チェックイン済み" : "チェックイン完了";
  elements.detailBody.replaceChildren();
  elements.detailPanel.classList.remove("hidden");
  elements.detailBackdrop.hidden = false;

  const card = document.createElement("div");
  card.className = "checkin-card";
  card.style.setProperty("--checkin-color", location.color);

  const burst = document.createElement("div");
  burst.className = "checkin-burst";
  burst.setAttribute("aria-hidden", "true");

  const badge = document.createElement("div");
  badge.className = "checkin-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = wasVisited ? "✓" : "★";

  const status = document.createElement("span");
  status.className = "checkin-status";
  status.textContent = wasVisited ? "ALREADY CHECKED-IN" : "MISSION COMPLETE";

  const message = document.createElement("span");
  message.className = "checkin-message";
  message.textContent = wasVisited ? "このスポットは記録済みです" : "チェックイン成功！";

  const name = document.createElement("strong");
  name.className = "checkin-name";
  name.textContent = location.name;

  const category = document.createElement("span");
  category.className = "checkin-category";
  category.textContent = location.category;

  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = wasVisited
    ? "訪問履歴に同じ記録があります。引き続きレーダー探索を続けましょう。"
    : "訪問履歴に記録しました。探索データを更新しました。";

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "primary-button";
  backButton.textContent = returnTo === "history" ? "地点履歴に戻る" : "レーダーに戻る";
  backButton.addEventListener("click", () => {
    if (returnTo === "history") {
      openDetailPanel("history");
      return;
    }
    closeDetailPanel();
  });

  card.append(burst, badge, status, message, name, category, note);
  elements.detailBody.append(card, backButton);
}

function stopQrScanner() {
  if (state.qrScanFrameId !== null) {
    cancelAnimationFrame(state.qrScanFrameId);
    state.qrScanFrameId = null;
  }

  if (state.qrStream) {
    state.qrStream.getTracks().forEach((track) => track.stop());
    state.qrStream = null;
  }

  state.qrScanLocked = false;
}

function getCameraErrorMessage(error) {
  if (error?.name === "NotAllowedError") return "カメラの利用が許可されていません。ブラウザの権限設定を確認してください。";
  if (error?.name === "NotFoundError") return "利用できるカメラが見つかりませんでした。";
  if (error?.name === "NotReadableError") return "カメラを起動できませんでした。他のアプリがカメラを使用していないか確認してください。";
  return "カメラを起動できませんでした。";
}

function renderGuideDetail() {
  const guide = document.createElement("div");
  guide.className = "guide-list";

  const items = [
    ["レーダーを見る", "最も近い未訪問スポットの反応方向が、8方向程度のグラデーションで表示されます。表示範囲バーで反応の強さの目安を切り替えられます。"],
    ["反応を更新", "レーダーは約5秒ごとに更新されます。画面右下の照準アイコンを押すと、現在地と反応をすぐに更新できます。GPS精度は画面左下に表示されます。"],
    ["QRでチェックイン", "建物内やGPSが不安定な場所では、上部のQR CHECK-INからチェックインします。"],
    ["カードを集める", "チェックインした地点は地点履歴に残り、メダルカードをいつでも見返せます。"],
  ];

  items.forEach(([title, text]) => {
    const item = document.createElement("section");
    item.className = "guide-item";

    const heading = document.createElement("strong");
    heading.textContent = title;

    const body = document.createElement("p");
    body.textContent = text;

    item.append(heading, body);
    guide.append(item);
  });

  elements.detailBody.append(guide);
}

function renderCategoryDetail() {
  elements.detailBody.replaceChildren();

  const lead = document.createElement("p");
  lead.className = "detail-note";
  lead.textContent = "レーダーに表示するカテゴリを切り替えます。";

  const options = document.createElement("div");
  options.className = "option-list";
  const categories = [...new Set(state.locations.map((location) => location.category))];

  categories.forEach((category) => {
    const button = document.createElement("button");
    const isVisible = state.visibleCategories.has(category);
    button.type = "button";
    button.className = "menu-option-button category-option";
    button.style.setProperty("--category-color", state.categoryColors.get(category) ?? "#70ffd6");
    button.textContent = category;
    button.setAttribute("aria-pressed", String(isVisible));
    button.classList.toggle("selected", isVisible);
    button.addEventListener("click", () => toggleCategory(category));
    options.append(button);
  });

  elements.detailBody.append(lead, options);
}

function toggleCategory(category) {
  if (state.visibleCategories.has(category)) {
    state.visibleCategories.delete(category);
  } else {
    state.visibleCategories.add(category);
  }

  render();
  renderCategoryDetail();
}

function renderLabelsDetail() {
  elements.detailBody.replaceChildren();

  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = "デバッグ用に、レーダー内の地点名表示を切り替えます。通常運用では非表示がおすすめです。";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary-button";
  button.setAttribute("aria-pressed", String(state.showLabels));
  button.textContent = state.showLabels ? "地点名を非表示にする" : "地点名を表示する";
  button.addEventListener("click", () => {
    toggleLocationLabels();
    renderLabelsDetail();
  });

  elements.detailBody.append(note, button);
}

function toggleLocationLabels() {
  state.showLabels = !state.showLabels;
  elements.radar.classList.toggle("show-labels", state.showLabels);
}

function renderHistoryDetail() {
  elements.detailBody.replaceChildren();

  const historyList = document.createElement("div");
  historyList.className = "history-card-list detail-history-list";

  if (!state.visits.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "訪問履歴はまだありません。";
    historyList.append(empty);
    elements.detailBody.append(historyList);
    return;
  }

  state.visits
    .slice()
    .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
    .forEach((visit) => {
      const location = findLocationByUuid(visit.id);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-card-button";
      item.style.setProperty("--history-color", location?.color ?? "var(--accent)");

      const medal = document.createElement("span");
      medal.className = "history-medal";
      medal.textContent = "★";

      const content = document.createElement("span");
      content.className = "history-card-content";

      const name = document.createElement("strong");
      name.textContent = visit.name;

      const date = document.createElement("span");
      date.className = "history-date";
      date.textContent = new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(visit.visitedAt));

      const action = document.createElement("span");
      action.className = "history-action";
      action.textContent = "カードを見る";

      content.append(name, date, action);
      item.append(medal, content);
      item.addEventListener("click", () => {
        if (location) {
          showCheckinDetail(location, true, "history");
        } else {
          elements.detailTitle.textContent = "地点履歴";
          elements.detailBody.replaceChildren();
          const note = document.createElement("p");
          note.className = "detail-note";
          note.textContent = "この地点は現在のCSVに見つからないため、カードを表示できませんでした。";
          elements.detailBody.append(note);
        }
      });
      historyList.append(item);
    });

  elements.detailBody.append(historyList);
}

async function updateCurrentLocation() {
  await startOrientationTracking(true);
  elements.locateIconButton.disabled = true;
  elements.locateIconButton.setAttribute("aria-busy", "true");
  elements.locationSummary.textContent = "反応を更新しています。立ち止まって周囲を確認してください。";
  elements.locationSummary.classList.remove("hidden");

  try {
    const [heading, position] = await Promise.all([
      getHeadingForDetection(),
      getCurrentPositionForDetection(),
    ]);

    if (position) {
      storeLatestPosition(position);
      state.currentPosition = { ...state.latestPosition };
      updateGpsAccuracyBadge();
    } else if (!state.currentPosition && state.latestPosition) {
      state.currentPosition = { ...state.latestPosition };
      updateGpsAccuracyBadge();
    }

    if (!state.currentPosition) {
      render();
      return;
    }

    state.heading = heading ?? state.heading;
    state.lockedHeading = null;
    render();
    pulseRadar();
  } finally {
    elements.locateIconButton.disabled = false;
    elements.locateIconButton.removeAttribute("aria-busy");
  }
}

function getHeadingForDetection() {
  return new Promise((resolve) => {
    resetHeadingCalibration();

    const startedAt = Date.now();
    const timeoutMs = 1400;
    const intervalId = window.setInterval(() => {
      if (state.heading !== null || Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(intervalId);
        resolve(state.heading);
      }
    }, 80);
  });
}

function getCurrentPositionForDetection() {
  if (!navigator.geolocation) {
    return Promise.resolve(null);
  }

  const options = {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 0,
  };

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => {
        handlePositionError(error);
        resolve(null);
      },
      options,
    );
  });
}

function startRadarDotDisplay() {
  clearRadarDotTimers();
  state.radarDotsVisible = true;
  state.radarDotsFading = false;

  const fadeDelay = Math.max(RADAR_DOT_VISIBLE_MS - RADAR_DOT_FADE_MS, 0);
  state.radarDotFadeTimerId = window.setTimeout(() => {
    state.radarDotsFading = true;
    renderRadar(getVisibleUnvisitedLocations());
  }, fadeDelay);

  state.radarDotTimerId = window.setTimeout(() => {
    hideRadarDots();
  }, RADAR_DOT_VISIBLE_MS);
}

function hideRadarDots() {
  clearRadarDotTimers();
  state.radarDotsVisible = false;
  state.radarDotsFading = false;
  renderRadar(getVisibleUnvisitedLocations());
}

function clearRadarDotTimers() {
  if (state.radarDotTimerId !== null) {
    window.clearTimeout(state.radarDotTimerId);
    state.radarDotTimerId = null;
  }

  if (state.radarDotFadeTimerId !== null) {
    window.clearTimeout(state.radarDotFadeTimerId);
    state.radarDotFadeTimerId = null;
  }
}

function renderResetDetail() {
  elements.detailBody.replaceChildren();

  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = "訪問履歴をすべて削除します。この操作は元に戻せません。";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "danger-button";
  button.textContent = "履歴をリセット";
  button.addEventListener("click", () => {
    const shouldReset = window.confirm("訪問履歴をすべて削除しますか？");
    if (!shouldReset) return;
    state.visits = [];
    saveVisits();
    render();
    renderResetDetail();
  });

  elements.detailBody.append(note, button);
}

function ensureStatusElements() {
  elements.locateIconButton.setAttribute("aria-label", "反応を更新");
  elements.locateIconButton.setAttribute("title", "反応を更新");
  if (!elements.gpsAccuracyBadge.dataset.level) {
    elements.gpsAccuracyBadge.dataset.level = "unknown";
  }
  if (!elements.gpsAccuracyBadge.title) {
    elements.gpsAccuracyBadge.title = "GPS 未受信";
  }

  if (!elements.qrNotice) {
    elements.qrNotice = document.createElement("div");
    elements.qrNotice.id = "qrNotice";
    elements.qrNotice.className = "notice hidden";
  }

  if (!elements.locationSummary) {
    elements.locationSummary = document.createElement("div");
    elements.locationSummary.id = "locationSummary";
    elements.locationSummary.className = "summary";
    elements.locationSummary.textContent = "現在地は未取得です。";
  }

  if (!elements.radarHint) {
    elements.radarHint = document.createElement("div");
    elements.radarHint.id = "radarHint";
    elements.radarHint.className = "radar-hint";
    elements.radarHint.textContent = "現在地を取得すると、近くの反応方向が表示されます。";
    elements.radar.append(elements.radarHint);
  }

  if (!elements.visitActions) {
    elements.visitActions = document.createElement("div");
    elements.visitActions.id = "visitActions";
    elements.visitActions.className = "visit-actions";
  }
}

async function startOrientationTracking(fromUserGesture = false) {
  if (state.orientationListening) {
    if (fromUserGesture) resetHeadingCalibration();
    return;
  }

  if (!("DeviceOrientationEvent" in window)) {
    return;
  }

  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    if (!fromUserGesture) {
      return;
    }

    try {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        return;
      }
    } catch {
      return;
    }
  }

  const eventName = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  window.addEventListener(eventName, handleOrientation, true);
  state.orientationEventName = eventName;
  state.orientationListening = true;
}

function handleOrientation(event) {
  let heading = null;
  const screenAngle = USE_SCREEN_ANGLE_COMPENSATION
    ? (screen.orientation?.angle ?? window.orientation ?? 0)
    : 0;
  state.lastRawWebkitCompassHeading = Number.isFinite(event.webkitCompassHeading)
    ? event.webkitCompassHeading
    : null;
  state.lastRawAlpha = Number.isFinite(event.alpha) ? event.alpha : null;
  state.lastEventAbsolute = event.absolute ?? null;
  state.lastScreenAngle = screenAngle;

  const hasReliableWebkitHeading = Number.isFinite(event.webkitCompassHeading)
    && (!Number.isFinite(event.webkitCompassAccuracy) || event.webkitCompassAccuracy >= 0);
  const hasAbsoluteAlpha = Number.isFinite(event.alpha)
    && (event.absolute === true || state.orientationEventName === "deviceorientationabsolute");

  if (hasReliableWebkitHeading) {
    heading = event.webkitCompassHeading + screenAngle;
  } else if (hasAbsoluteAlpha) {
    heading = 360 - event.alpha + screenAngle;
  }

  if (heading === null) return;

  const normalizedHeading = normalizeHeading(heading);
  state.lastNormalizedHeading = normalizedHeading;

  if (state.heading === null) {
    if (state.orientationSampleStartedAt === null) {
      state.orientationSampleStartedAt = Date.now();
    }
    state.orientationSamples.push(normalizedHeading);
    const sampleDuration = Date.now() - state.orientationSampleStartedAt;
    if (state.orientationSamples.length < 8 || sampleDuration < 600) return;

    const initialHeading = getStableCircularAverage(state.orientationSamples);
    if (initialHeading === null) {
      state.orientationSamples = state.orientationSamples.slice(-2);
      state.orientationSampleStartedAt = Date.now();
      return;
    }

    state.heading = initialHeading;
    state.orientationSamples = [];
    state.orientationSampleStartedAt = null;
  } else {
    state.heading = smoothHeading(state.heading, normalizedHeading, 0.3);
  }

  updateRadarOrientation();
}

function resetHeadingCalibration() {
  state.heading = null;
  state.orientationSamples = [];
  state.orientationSampleStartedAt = null;
}

function normalizeHeading(heading) {
  return (heading % 360 + 360) % 360;
}

function getStableCircularAverage(headings) {
  const vectors = headings.map((heading) => toRadians(heading));
  const x = vectors.reduce((sum, angle) => sum + Math.cos(angle), 0) / vectors.length;
  const y = vectors.reduce((sum, angle) => sum + Math.sin(angle), 0) / vectors.length;
  const concentration = Math.hypot(x, y);

  if (concentration < 0.75) return null;
  return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

function smoothHeading(current, next, amount) {
  const shortestDelta = ((next - current + 540) % 360) - 180;
  return normalizeHeading(current + shortestDelta * amount);
}

async function loadLocations() {
  const response = await fetch(CSV_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${CSV_PATH} を取得できませんでした`);
  }

  const rows = parseCsv(await response.text());
  const [header, ...records] = rows.filter((row) => row.some(Boolean));
  const required = ["地点名", "カテゴリ", "緯度", "経度", "判定半径", "表示色", "UUID"];

  if (!header || !required.every((name) => header.includes(name))) {
    throw new Error(`CSVには ${required.join(", ")} の列が必要です`);
  }

  const categoryColors = new Map();
  const locations = records.map((record, index) => {
    const values = Object.fromEntries(header.map((name, columnIndex) => [name, record[columnIndex]?.trim() ?? ""]));
    const latitude = Number(values["緯度"]);
    const longitude = Number(values["経度"]);
    const radius = Number(values["判定半径"]);
    const category = values["カテゴリ"];
    const color = values["表示色"];

    if (!values["地点名"] || !category || !color || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || !values.UUID) {
      throw new Error(`CSVの${index + 2}行目に不正な値があります`);
    }

    if (!categoryColors.has(category)) {
      categoryColors.set(category, color);
    }

    return {
      id: values.UUID,
      name: values["地点名"],
      category,
      latitude,
      longitude,
      radius,
      color: categoryColors.get(category),
    };
  });

  state.categoryColors = categoryColors;
  return locations;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && insideQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

async function handleQrVisit() {
  const uuid = new URLSearchParams(window.location.search).get("uuid");
  if (!uuid) return;

  const location = findLocationByUuid(uuid);
  if (!location) {
    showNotice("QRコードのUUIDに一致する地点が見つかりませんでした。");
    return;
  }

  const wasVisited = isVisited(location.id);
  recordVisit(location);
  showCheckinDetail(location, wasVisited, "radar");
}

function startPositionTracking(applyImmediately = false) {
  if (!navigator.geolocation) {
    elements.locationSummary.textContent = "このブラウザは位置情報に対応していません。QRコードからの記録は利用できます。";
    return;
  }

  elements.locationSummary.textContent = "現在地を取得しています...";
  elements.locationSummary.classList.remove("hidden");
  const options = {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 5000,
  };

  navigator.geolocation.getCurrentPosition(
    (position) => {
      storeLatestPosition(position);
      applyLatestPosition();
    },
    handlePositionError,
    options,
  );

  if (state.positionWatchId === null) {
    state.positionWatchId = navigator.geolocation.watchPosition(
      (position) => {
        storeLatestPosition(position);
        if (state.currentPosition === null || applyImmediately) {
          applyLatestPosition();
          applyImmediately = false;
        }
      },
      handlePositionError,
      options,
    );
  }

  if (state.positionRefreshTimerId === null) {
    state.positionRefreshTimerId = window.setInterval(() => {
      applyLatestPosition();
    }, RADAR_REFRESH_MS);
  }
}

function storeLatestPosition(position) {
  state.latestPosition = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp,
  };
}

function handlePositionError(error) {
  if (state.currentPosition !== null) return;

  elements.locationSummary.textContent = getGeolocationErrorMessage(error);
  elements.locationSummary.classList.remove("hidden");
  elements.gpsAccuracyBadge.textContent = "GPS 低";
  elements.gpsAccuracyBadge.title = "GPS 取得失敗";
  elements.gpsAccuracyBadge.dataset.level = "low";
}

function applyLatestPosition() {
  if (!state.latestPosition) return;

  state.currentPosition = { ...state.latestPosition };
  render();
  updateGpsAccuracyBadge();
  pulseRadar();
}

function pulseRadar() {
  elements.radar.classList.remove("location-pulse");
  void elements.radar.offsetWidth;
  elements.radar.classList.add("location-pulse");
}

function getGeolocationErrorMessage(error) {
  if (error.code === error.PERMISSION_DENIED) return "位置情報の利用が許可されていません。QRコードからの記録は利用できます。";
  if (error.code === error.POSITION_UNAVAILABLE) return "現在地を取得できませんでした。屋内ではQRコードから記録してください。";
  if (error.code === error.TIMEOUT) return "現在地の取得がタイムアウトしました。もう一度お試しください。";
  return "現在地を取得できませんでした。";
}

function updateGpsAccuracyBadge() {
  if (!state.currentPosition) {
    elements.gpsAccuracyBadge.textContent = "GPS --";
    elements.gpsAccuracyBadge.title = "GPS 未受信";
    elements.gpsAccuracyBadge.dataset.level = "unknown";
    return;
  }

  const accuracy = state.currentPosition.accuracy;
  if (!Number.isFinite(accuracy)) {
    elements.gpsAccuracyBadge.textContent = "GPS --";
    elements.gpsAccuracyBadge.title = "GPS 精度不明";
    elements.gpsAccuracyBadge.dataset.level = "unknown";
    return;
  }

  const roundedAccuracy = Math.round(accuracy);
  const level = getGpsAccuracyLevel(accuracy);
  elements.gpsAccuracyBadge.textContent = `GPS ${level.label}`;
  elements.gpsAccuracyBadge.title = `GPS ${level.label}・約${roundedAccuracy}m`;
  elements.gpsAccuracyBadge.dataset.level = level.key;
}

function getGpsAccuracyLevel(accuracy) {
  if (accuracy <= 20) return { key: "high", label: "高" };
  if (accuracy <= 60) return { key: "medium", label: "中" };
  return { key: "low", label: "低" };
}

function render() {
  const unvisited = getVisibleUnvisitedLocations();
  renderSummary(unvisited);
  renderRadar(unvisited);
  updateRadarOrientation();
  renderVisitActions(unvisited);
}

function getVisibleUnvisitedLocations() {
  return state.locations.filter((location) => (
    !isVisited(location.id) && state.visibleCategories.has(location.category)
  ));
}

function getNearestLocation(locations) {
  if (!state.currentPosition) return null;

  return locations.reduce((nearest, location) => {
    const distance = getDistanceMeters(state.currentPosition, location);
    if (nearest && distance >= nearest.distance) return nearest;

    return {
      location,
      distance,
      bearing: getBearingDegrees(state.currentPosition, location),
    };
  }, null);
}

function renderSummary(unvisited) {
  if (!state.locations.length) return;

  if (!state.currentPosition) {
    elements.locationSummary.textContent = "現在地を取得するとレーダーに方向が表示されます。";
    return;
  }

  elements.locationSummary.textContent = "";
  elements.locationSummary.classList.add("hidden");
}

function renderRadar(unvisited) {
  elements.radarMarkers.replaceChildren();
  elements.radarMarkers.classList.remove("is-fading");
  elements.radar.classList.remove("is-detecting", "has-reaction");

  if (!state.currentPosition) {
    elements.radarHint.textContent = "現在地を取得すると、近くの反応方向が表示されます。";
    elements.radarHint.hidden = false;
    return;
  }

  const nearest = getNearestLocation(unvisited);
  if (!nearest) {
    elements.radarHint.textContent = "記録できる反応はありません。";
    elements.radarHint.hidden = false;
    return;
  }

  const maxDistanceMeters = RADAR_RANGES[state.radarRangeMode];
  const distanceRatio = Math.min(nearest.distance / maxDistanceMeters, 1);
  const strength = 1 - distanceRatio;
  const gradient = document.createElement("span");
  gradient.className = "reaction-gradient";
  gradient.dataset.name = nearest.location.name;
  gradient.dataset.bearing = String(nearest.bearing);
  gradient.setAttribute("aria-hidden", "true");
  gradient.style.setProperty("--reaction-rgb", "142, 83, 31");
  gradient.style.setProperty("--reaction-alpha-strong", String(0.26 + strength * 0.46));
  gradient.style.setProperty("--reaction-alpha-soft", String(0.08 + strength * 0.24));
  positionReactionGradient(gradient);

  elements.radarHint.hidden = true;
  elements.radar.classList.add("has-reaction");
  elements.radarMarkers.append(gradient);
}

function updateRadarOrientation() {
  elements.radarMarkers.querySelectorAll(".reaction-gradient").forEach(positionReactionGradient);
  elements.compassLabels.querySelectorAll("[data-bearing]").forEach(positionCompassLabel);
}

function positionReactionGradient(gradient) {
  const bearing = Number(gradient.dataset.bearing);
  const displayHeading = getDisplayHeading();
  const relativeBearing = bearing - displayHeading;
  const reactionAngle = quantizeToEightDirections(relativeBearing);

  gradient.style.setProperty("--reaction-angle", `${reactionAngle}deg`);
  logHeadingDebug({
    markerName: gradient.dataset.name ?? "",
    bearing,
    displayHeading,
    relativeBearing,
  });
}

function positionCompassLabel(label) {
  const bearing = Number(label.dataset.bearing);
  const radiusPercent = 42;
  const displayHeading = getDisplayHeading();
  const relativeBearing = bearing - displayHeading;
  const angle = (relativeBearing - 90) * Math.PI / 180;
  const position = {
    left: 50 + Math.cos(angle) * radiusPercent,
    top: 50 + Math.sin(angle) * radiusPercent,
  };

  label.style.left = `${position.left}%`;
  label.style.top = `${position.top}%`;
}

function getDisplayHeading() {
  const heading = state.lockedHeading ?? state.heading;
  if (heading === null) return 0;
  return normalizeHeading(heading + HEADING_DISPLAY_OFFSET_DEGREES);
}

function quantizeToEightDirections(angle) {
  return Math.round(getSignedAngleDegrees(angle) / 45) * 45;
}

function getSignedAngleDegrees(angle) {
  return ((angle % 360) + 540) % 360 - 180;
}

function getRadarPoint(bearing, heading, radiusPercent) {
  const relativeBearing = bearing - heading;
  const angle = (relativeBearing - 90) * Math.PI / 180;

  return {
    left: 50 + Math.cos(angle) * radiusPercent,
    top: 50 + Math.sin(angle) * radiusPercent,
  };
}

function logHeadingDebug({ markerName, bearing, displayHeading, relativeBearing }) {
  if (!DEBUG_HEADING) return;

  console.log("[radar-heading]", {
    markerName,
    screenAngle: state.lastScreenAngle,
    eventWebkitCompassHeading: state.lastRawWebkitCompassHeading,
    eventAlpha: state.lastRawAlpha,
    eventAbsolute: state.lastEventAbsolute,
    orientationEventName: state.orientationEventName,
    stateHeading: state.heading,
    displayHeading,
    bearing,
    relativeBearing,
    normalizedHeading: state.lastNormalizedHeading,
    useScreenAngleCompensation: USE_SCREEN_ANGLE_COMPENSATION,
    headingDisplayOffsetDegrees: HEADING_DISPLAY_OFFSET_DEGREES,
  });
}

function debugRadarHeadingTest(radiusPercent = 40) {
  const bearings = [0, 90, 180, 270];
  const cases = [
    { heading: 0, expected: "0=上, 90=右, 180=下, 270=左" },
    { heading: 90, expected: "bearing 0=左" },
  ];

  return cases.map(({ heading, expected }) => ({
    heading,
    expected,
    useScreenAngleCompensation: USE_SCREEN_ANGLE_COMPENSATION,
    headingDisplayOffsetDegrees: HEADING_DISPLAY_OFFSET_DEGREES,
    points: Object.fromEntries(
      bearings.map((bearing) => {
        const point = getRadarPoint(bearing, heading, radiusPercent);
        return [bearing, {
          left: Number(point.left.toFixed(2)),
          top: Number(point.top.toFixed(2)),
        }];
      }),
    ),
  }));
}

if (typeof window !== "undefined") {
  window.debugRadarHeadingTest = debugRadarHeadingTest;
}

function renderVisitActions(unvisited) {
  elements.visitActions.replaceChildren();
  if (!state.currentPosition) return;

  const reachable = unvisited
    .map((location) => ({ location, distance: getDistanceMeters(state.currentPosition, location) }))
    .filter(({ location, distance }) => distance <= location.radius)
    .sort((a, b) => a.distance - b.distance);

  reachable.forEach(({ location }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "visit-button";
    button.textContent = `${location.name} を記録`;
    button.addEventListener("click", () => {
      recordVisit(location);
      render();
      showNotice(`${location.name} を訪問済みにしました。`);
    });
    elements.visitActions.append(button);
  });
}

function recordVisit(location) {
  if (isVisited(location.id)) return;

  state.visits.push({
    id: location.id,
    name: location.name,
    visitedAt: new Date().toISOString(),
  });
  saveVisits();
  if (state.activeDetailSection === "history") renderHistoryDetail();
}

function isVisited(id) {
  return state.visits.some((visit) => visit.id === id);
}

function loadVisits() {
  try {
    const visits = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(visits) ? visits : [];
  } catch {
    return [];
  }
}

function saveVisits() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visits));
}

function showNotice(message) {
  elements.qrNotice.textContent = message;
  elements.qrNotice.classList.remove("hidden");
}

function getDistanceMeters(from, to) {
  const earthRadiusMeters = 6371000;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function getBearingDegrees(from, to) {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}
