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
const HEADING_DISPLAY_OFFSET_DEGREES = 180;
const CATEGORY_COLORS = {
  ハンビータウン店: "#a78bfa",
  飲食店: "#ff7b7b",
  小売店: "#62e6a8",
  観光地: "#f6c65b",
};

const state = {
  locations: [],
  visits: loadVisits(),
  currentPosition: null,
  latestPosition: null,
  positionWatchId: null,
  heading: null,
  orientationSamples: [],
  orientationSampleStartedAt: null,
  orientationListening: false,
  orientationEventName: null,
  showLabels: false,
  radarRangeMode: "normal",
  pendingRadarRangeMode: null,
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
  qrNotice: null,
  locationSummary: null,
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
  elements.menuButton.addEventListener("click", openMenu);
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

  elements.radarSweep.addEventListener("animationiteration", applyLatestPosition);
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

  if (section === "status") {
    elements.detailTitle.textContent = "記録状況";
    renderStatusDetail();
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
  showCheckinDetail(location, wasVisited);
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

function showCheckinDetail(location, wasVisited = false) {
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

  const backToRadar = document.createElement("button");
  backToRadar.type = "button";
  backToRadar.className = "primary-button";
  backToRadar.textContent = "レーダーに戻る";
  backToRadar.addEventListener("click", closeDetailPanel);

  card.append(burst, badge, status, message, name, category, note);
  elements.detailBody.append(card, backToRadar);
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

function renderStatusDetail() {
  ensureStatusElements();

  const help = document.createElement("p");
  help.className = "detail-note";
  help.textContent = "現在地の更新は画面下部の照準アイコンから行えます。近くの地点に入ると、この画面に記録ボタンが表示されます。";

  elements.detailBody.append(elements.qrNotice, elements.locationSummary, elements.visitActions, help);
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
    button.style.setProperty("--category-color", CATEGORY_COLORS[category]);
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
          showCheckinDetail(location, true);
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
  startPositionTracking(true);
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
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;

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

  return records.map((record, index) => {
    const values = Object.fromEntries(header.map((name, columnIndex) => [name, record[columnIndex]?.trim() ?? ""]));
    const latitude = Number(values["緯度"]);
    const longitude = Number(values["経度"]);
    const radius = Number(values["判定半径"]);
    const category = values["カテゴリ"];
    const color = values["表示色"];

    const hasValidCategoryColor = Object.prototype.hasOwnProperty.call(CATEGORY_COLORS, category)
      && color.toLowerCase() === CATEGORY_COLORS[category];

    if (!values["地点名"] || !hasValidCategoryColor || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || !values.UUID) {
      throw new Error(`CSVの${index + 2}行目に不正な値があります`);
    }

    return {
      id: values.UUID,
      name: values["地点名"],
      category,
      latitude,
      longitude,
      radius,
      color,
    };
  });
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
  showCheckinDetail(location, wasVisited);
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
}

function applyLatestPosition() {
  if (!state.latestPosition) return;

  state.currentPosition = { ...state.latestPosition };
  render();
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

function render() {
  const unvisited = state.locations.filter((location) => (
    !isVisited(location.id) && state.visibleCategories.has(location.category)
  ));
  renderSummary(unvisited);
  renderRadar(unvisited);
  updateRadarOrientation();
  renderVisitActions(unvisited);
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
  if (!state.currentPosition) return;

  const maxDistanceMeters = RADAR_RANGES[state.radarRangeMode];

  unvisited.forEach((location) => {
    const distance = getDistanceMeters(state.currentPosition, location);
    const bearing = getBearingDegrees(state.currentPosition, location);
    const distanceRatio = Math.min(distance / maxDistanceMeters, 1);
    const radiusPercent = 46 * distanceRatio;

    const marker = document.createElement("span");
    marker.className = "marker";
    marker.dataset.bearing = String(bearing);
    marker.dataset.radiusPercent = String(radiusPercent);
    marker.style.setProperty("--marker-color", location.color);
    marker.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "marker-label";
    label.textContent = location.name;
    marker.append(label);

    positionRadarMarker(marker);
    elements.radarMarkers.append(marker);
  });
}

function updateRadarOrientation() {
  elements.radarMarkers.querySelectorAll(".marker").forEach(positionRadarMarker);
  elements.compassLabels.querySelectorAll("[data-bearing]").forEach(positionCompassLabel);
}

function positionRadarMarker(marker) {
  const bearing = Number(marker.dataset.bearing);
  const radiusPercent = Number(marker.dataset.radiusPercent);
  const relativeBearing = bearing - getDisplayHeading();
  const angle = (relativeBearing - 90) * Math.PI / 180;

  marker.style.left = `${50 + Math.cos(angle) * radiusPercent}%`;
  marker.style.top = `${50 + Math.sin(angle) * radiusPercent}%`;
}

function positionCompassLabel(label) {
  const bearing = Number(label.dataset.bearing);
  const relativeBearing = bearing - getDisplayHeading();
  const angle = (relativeBearing - 90) * Math.PI / 180;
  const radiusPercent = 42;

  label.style.left = `${50 + Math.cos(angle) * radiusPercent}%`;
  label.style.top = `${50 + Math.sin(angle) * radiusPercent}%`;
}

function getDisplayHeading() {
  if (state.heading === null) return 0;
  return normalizeHeading(state.heading + HEADING_DISPLAY_OFFSET_DEGREES);
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
