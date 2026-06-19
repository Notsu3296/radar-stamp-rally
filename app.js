const CSV_PATH = "locations.csv";
const STORAGE_KEY = "location-game-visits";
const RADAR_MAX_DISTANCE_METERS = 1000;

const state = {
  locations: [],
  visits: loadVisits(),
  currentPosition: null,
};

const elements = {
  statusText: document.querySelector("#statusText"),
  radarMarkers: document.querySelector("#radarMarkers"),
  locateButton: document.querySelector("#locateButton"),
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

  try {
    state.locations = await loadLocations();
    await handleQrVisit();
    render();
    requestCurrentPosition();
  } catch (error) {
    elements.statusText.textContent = "地点データの読み込みに失敗しました";
    elements.locationSummary.textContent = error.message;
    render();
  }
}

function bindEvents() {
  elements.locateButton.addEventListener("click", requestCurrentPosition);
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

async function loadLocations() {
  const response = await fetch(CSV_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${CSV_PATH} を取得できませんでした`);
  }

  const rows = parseCsv(await response.text());
  const [header, ...records] = rows.filter((row) => row.some(Boolean));
  const required = ["地点名", "緯度", "経度", "判定半径", "UUID"];

  if (!header || !required.every((name) => header.includes(name))) {
    throw new Error(`CSVには ${required.join(", ")} の列が必要です`);
  }

  return records.map((record, index) => {
    const values = Object.fromEntries(header.map((name, columnIndex) => [name, record[columnIndex]?.trim() ?? ""]));
    const latitude = Number(values["緯度"]);
    const longitude = Number(values["経度"]);
    const radius = Number(values["判定半径"]);

    if (!values["地点名"] || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius) || !values.UUID) {
      throw new Error(`CSVの${index + 2}行目に不正な値があります`);
    }

    return {
      id: values.UUID,
      name: values["地点名"],
      latitude,
      longitude,
      radius,
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

function requestCurrentPosition() {
  if (!navigator.geolocation) {
    elements.locationSummary.textContent = "このブラウザは位置情報に対応していません。QRコードからの記録は利用できます。";
    return;
  }

  elements.locationSummary.textContent = "現在地を取得しています...";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.currentPosition = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp,
      };
      render();
    },
    (error) => {
      state.currentPosition = null;
      elements.locationSummary.textContent = getGeolocationErrorMessage(error);
      render();
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 5000,
    },
  );
}

function getGeolocationErrorMessage(error) {
  if (error.code === error.PERMISSION_DENIED) return "位置情報の利用が許可されていません。QRコードからの記録は利用できます。";
  if (error.code === error.POSITION_UNAVAILABLE) return "現在地を取得できませんでした。屋内ではQRコードから記録してください。";
  if (error.code === error.TIMEOUT) return "現在地の取得がタイムアウトしました。もう一度お試しください。";
  return "現在地を取得できませんでした。";
}

function render() {
  const unvisited = state.locations.filter((location) => !isVisited(location.id));
  elements.statusText.textContent = `未到達地点：${toFullWidthNumber(unvisited.length)}`;
  renderSummary(unvisited);
  renderRadar(unvisited);
  renderVisitActions(unvisited);
}

function renderSummary(unvisited) {
  if (!state.locations.length) return;

  if (!state.currentPosition) {
    elements.locationSummary.textContent = "現在地を取得するとレーダーに方向が表示されます。";
    return;
  }

  const nearest = unvisited
    .map((location) => ({ location, distance: getDistanceMeters(state.currentPosition, location) }))
    .sort((a, b) => a.distance - b.distance)[0];

  const accuracy = Math.round(state.currentPosition.accuracy);
  if (!nearest) {
    elements.locationSummary.textContent = `すべての地点を訪問済みです。位置精度は約${accuracy}mです。`;
    return;
  }

  elements.locationSummary.textContent = `最寄りの未訪問地点は ${nearest.location.name}、約${Math.round(nearest.distance)}m先です。位置精度は約${accuracy}mです。`;
}

function renderRadar(unvisited) {
  elements.radarMarkers.replaceChildren();
  if (!state.currentPosition) return;

  unvisited.forEach((location) => {
    const distance = getDistanceMeters(state.currentPosition, location);
    const bearing = getBearingDegrees(state.currentPosition, location);
    const distanceRatio = Math.min(distance / RADAR_MAX_DISTANCE_METERS, 1);
    const radiusPercent = 46 * distanceRatio;
    const angle = (bearing - 90) * Math.PI / 180;
    const left = 50 + Math.cos(angle) * radiusPercent;
    const top = 50 + Math.sin(angle) * radiusPercent;

    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "marker";
    marker.style.left = `${left}%`;
    marker.style.top = `${top}%`;
    marker.dataset.name = location.name;
    marker.title = `${location.name}: 約${Math.round(distance)}m`;
    marker.addEventListener("click", () => showNotice(`${location.name}: 約${Math.round(distance)}m先`));
    elements.radarMarkers.append(marker);
  });
}

function renderVisitActions(unvisited) {
  elements.visitActions.replaceChildren();
  if (!state.currentPosition) return;

  const reachable = unvisited
    .map((location) => ({ location, distance: getDistanceMeters(state.currentPosition, location) }))
    .filter(({ location, distance }) => distance <= location.radius)
    .sort((a, b) => a.distance - b.distance);

  reachable.forEach(({ location, distance }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "visit-button";
    button.textContent = `${location.name} を記録 (${Math.round(distance)}m)`;
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

function toFullWidthNumber(value) {
  return String(value).replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0));
}
