const CSV_PATH = "locations.csv";
const STORAGE_KEY = "location-game-visits";
const RADAR_RANGES = {
  detail: 250,
  overview: 1000,
};

const state = {
  locations: [],
  visits: loadVisits(),
  currentPosition: null,
  latestPosition: null,
  positionWatchId: null,
  heading: null,
  orientationListening: false,
  showLabels: false,
  radarRangeMode: "overview",
};

const elements = {
  radarMarkers: document.querySelector("#radarMarkers"),
  radarSweep: document.querySelector(".radar-sweep"),
  radar: document.querySelector("#radar"),
  compassLabels: document.querySelector("#compassLabels"),
  locateButton: document.querySelector("#locateButton"),
  rangeButton: document.querySelector("#rangeButton"),
  labelsButton: document.querySelector("#labelsButton"),
  historyButton: document.querySelector("#historyButton"),
  resetButton: document.querySelector("#resetButton"),
  visitActions: document.querySelector("#visitActions"),
  locationSummary: document.querySelector("#locationSummary"),
  qrNotice: document.querySelector("#qrNotice"),
  historyDialog: document.querySelector("#historyDialog"),
  closeHistoryButton: document.querySelector("#closeHistoryButton"),
  historyList: document.querySelector("#historyList"),
};

init();

async function init() {
  bindEvents();
  startOrientationTracking();

  try {
    state.locations = await loadLocations();
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
  elements.locateButton.addEventListener("click", async () => {
    await startOrientationTracking(true);
    startPositionTracking(true);
  });
  elements.labelsButton.addEventListener("click", toggleLocationLabels);
  elements.rangeButton.addEventListener("click", toggleRadarRange);
  elements.radarSweep.addEventListener("animationiteration", applyLatestPosition);
  elements.historyButton.addEventListener("click", () => {
    renderHistory();
    elements.historyDialog.showModal();
  });
  elements.closeHistoryButton.addEventListener("click", () => elements.historyDialog.close());
  elements.resetButton.addEventListener("click", () => {
    const shouldReset = window.confirm("訪問履歴をすべて削除しますか？");
    if (!shouldReset) return;
    state.visits = [];
    saveVisits();
    render();
  });
}

function toggleLocationLabels() {
  state.showLabels = !state.showLabels;
  elements.radar.classList.toggle("show-labels", state.showLabels);
  elements.labelsButton.setAttribute("aria-pressed", String(state.showLabels));
  elements.labelsButton.textContent = state.showLabels ? "地点名を非表示" : "地点名を表示";
}

function toggleRadarRange() {
  const showingOverview = state.radarRangeMode === "overview";
  state.radarRangeMode = showingOverview ? "detail" : "overview";
  elements.rangeButton.setAttribute("aria-pressed", String(!showingOverview));
  elements.rangeButton.textContent = showingOverview ? "表示範囲：詳細" : "表示範囲：通常";
  renderRadar(state.locations.filter((location) => !isVisited(location.id)));
  updateRadarOrientation();
  pulseRadar();
}

async function startOrientationTracking(fromUserGesture = false) {
  if (state.orientationListening) return;

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
  state.orientationListening = true;
}

function handleOrientation(event) {
  let heading = null;
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;

  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading + screenAngle;
  } else if (Number.isFinite(event.alpha)) {
    heading = 360 - event.alpha + screenAngle;
  }

  if (heading === null) return;

  state.heading = normalizeHeading(heading);
  updateRadarOrientation();
}

function normalizeHeading(heading) {
  return (heading % 360 + 360) % 360;
}

async function loadLocations() {
  const response = await fetch(CSV_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${CSV_PATH} を取得できませんでした`);
  }

  const rows = parseCsv(await response.text());
  const [header, ...records] = rows.filter((row) => row.some(Boolean));
  const required = ["地点名", "緯度", "経度", "判定半径", "表示色", "UUID"];

  if (!header || !required.every((name) => header.includes(name))) {
    throw new Error(`CSVには ${required.join(", ")} の列が必要です`);
  }

  return records.map((record, index) => {
    const values = Object.fromEntries(header.map((name, columnIndex) => [name, record[columnIndex]?.trim() ?? ""]));
    const latitude = Number(values["緯度"]);
    const longitude = Number(values["経度"]);
    const radius = Number(values["判定半径"]);
    const color = values["表示色"];

    if (!values["地点名"] || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || !/^#[0-9a-f]{6}$/i.test(color) || !values.UUID) {
      throw new Error(`CSVの${index + 2}行目に不正な値があります`);
    }

    return {
      id: values.UUID,
      name: values["地点名"],
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

  const location = state.locations.find((item) => item.id.toLowerCase() === uuid.toLowerCase());
  if (!location) {
    showNotice("QRコードのUUIDに一致する地点が見つかりませんでした。");
    return;
  }

  recordVisit(location);
  showNotice(`${location.name} を訪問済みにしました。`);
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
  const unvisited = state.locations.filter((location) => !isVisited(location.id));
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
  const relativeBearing = bearing - (state.heading ?? 0);
  const angle = (relativeBearing - 90) * Math.PI / 180;

  marker.style.left = `${50 + Math.cos(angle) * radiusPercent}%`;
  marker.style.top = `${50 + Math.sin(angle) * radiusPercent}%`;
}

function positionCompassLabel(label) {
  const bearing = Number(label.dataset.bearing);
  const relativeBearing = bearing - (state.heading ?? 0);
  const angle = (relativeBearing - 90) * Math.PI / 180;
  const radiusPercent = 42;

  label.style.left = `${50 + Math.cos(angle) * radiusPercent}%`;
  label.style.top = `${50 + Math.sin(angle) * radiusPercent}%`;
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

function renderHistory() {
  elements.historyList.replaceChildren();

  if (!state.visits.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "訪問履歴はまだありません。";
    elements.historyList.append(empty);
    return;
  }

  state.visits
    .slice()
    .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
    .forEach((visit) => {
      const item = document.createElement("div");
      item.className = "history-item";

      const name = document.createElement("strong");
      name.textContent = visit.name;

      const date = document.createElement("span");
      date.textContent = new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(visit.visitedAt));

      item.append(name, date);
      elements.historyList.append(item);
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
  renderHistory();
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
