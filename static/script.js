/**
 * script.js — BloodBridge Frontend
 *
 * Handles:
 *   - Login / app entry flow
 *   - Tab switching
 *   - Dashboard: hospital inventory cards + alert sidebar
 *   - Exchange Network: Leaflet map + blood type filter + transfer recommendations
 *   - AI Predictions: risk cards + doughnut chart + feature importance
 *   - Analytics: Chart.js charts + hospital stress table
 */

"use strict";

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let currentUser       = null;
let currentHospital   = null;
let allHospitals      = [];
let overviewData      = null;
let mapInstance       = null;
let mapMarkers        = [];
let mapOverlays       = [];
let heatmapData       = [];
let transferLine      = null;
let predictionData    = [];
let charts            = {};

const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const STATUS_COLORS = {
  stable:    "#00e676",
  warning:   "#ffab40",
  high_risk: "#ff7043",
  critical:  "#ff1744",
};

const RISK_COLORS = {
  0: "#00e676",
  1: "#ffab40",
  2: "#ff7043",
  3: "#ff1744",
};

const RISK_LABELS = {
  0: "Stable",
  1: "Watchlist",
  2: "High Risk",
  3: "Critical",
};


// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }
function fmt(n)   { return typeof n === "number" ? n.toLocaleString() : n; }

function statusBadgeHTML(status) {
  const labels = { stable: "Stable", warning: "Warning", high_risk: "High Risk", critical: "Critical" };
  const cls    = { stable: "badge-green", warning: "badge-amber", high_risk: "badge-amber", critical: "badge-red" };
  return `<span class="badge ${cls[status] || 'badge-blue'}">${labels[status] || status}</span>`;
}

function riskBadgeHTML(riskLevel) {
  const colorMap = { 0: "#00e67620", 1: "#ffab4020", 2: "#ff704320", 3: "#ff174420" };
  const borderMap= { 0: "#00e67640", 1: "#ffab4040", 2: "#ff704340", 3: "#ff174440" };
  return `<span class="risk-badge"
    style="background:${colorMap[riskLevel]};
           color:${RISK_COLORS[riskLevel]};
           border:1px solid ${borderMap[riskLevel]}"
  >${RISK_LABELS[riskLevel]}</span>`;
}

function supplyBarColor(status) {
  return STATUS_COLORS[status] || "#7a9cc0";
}

function supplyBarWidth(daysSupply) {
  // Map days of supply to a 0-100% bar. Full at 30+ days.
  return Math.min(100, Math.round((daysSupply / 30) * 100));
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}


// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------

(async function initLogin() {
  // Preload hospitals into login form selector
  try {
    const resp = await fetch("/api/hospitals");
    allHospitals = await resp.json();
    const sel = el("login-hospital");
    sel.innerHTML = '<option value="" disabled selected>Select your hospital</option>';
    allHospitals.forEach(h => {
      const opt = document.createElement("option");
      opt.value = h.name;
      opt.textContent = `${h.name} — ${h.city}, ${h.state}`;
      sel.appendChild(opt);
    });
  } catch(e) {
    console.warn("Could not preload hospitals for login:", e);
  }
})();

el("login-form").addEventListener("submit", async function(e) {
  e.preventDefault();
  const name     = el("login-name").value.trim();
  const role     = el("login-role").value;
  const hospital = el("login-hospital").value;

  if (!name || !role || !hospital) return;

  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role }),
    });
    const data = await resp.json();
    if (!data.success) return;

    currentUser     = { name, role };
    currentHospital = hospital;

    // Update user pill
    setText("user-name-display", name);
    setText("user-role-display", role);
    el("user-avatar").textContent = name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();

    // Transition
    el("login-overlay").classList.add("fade-out");
    setTimeout(() => {
      el("login-overlay").style.display = "none";
      el("app").classList.remove("hidden");
      bootApp();
    }, 480);
  } catch(err) {
    console.error("Login error:", err);
  }
});


// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------

async function bootApp() {
  // Populate hospital selector
  const sel = el("hospital-selector");
  sel.innerHTML = "";
  allHospitals.forEach(h => {
    const opt = document.createElement("option");
    opt.value = h.name;
    opt.textContent = `${h.name}`;
    sel.appendChild(opt);
  });
  if (currentHospital) sel.value = currentHospital;

  sel.addEventListener("change", function() {
    currentHospital = this.value;
    loadDashboard(currentHospital);
  });

  // Load overview (populates KPIs and alert banner)
  await loadOverview();

  // Load dashboard for selected hospital
  if (currentHospital) await loadDashboard(currentHospital);

  // Pre-populate transfer hospital selectors
  const tSel = el("transfer-hospital");
  allHospitals.forEach(h => {
    const opt = document.createElement("option");
    opt.value = h.name;
    opt.textContent = h.name;
    tSel.appendChild(opt);
  });
  if (currentHospital) tSel.value = currentHospital;
}


// ---------------------------------------------------------------------------
// TAB SWITCHING
// ---------------------------------------------------------------------------

function switchTab(tabId, btn) {
  // Hide all panels
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));

  el(`tab-${tabId}`).classList.add("active");
  if (btn) btn.classList.add("active");

  // Lazy-load tab content
  if (tabId === "exchange") initExchangeTab();
  if (tabId === "predictions") loadPredictions();
  if (tabId === "analytics")   loadAnalytics();
}


// ---------------------------------------------------------------------------
// OVERVIEW (KPIs + Banner)
// ---------------------------------------------------------------------------

async function loadOverview() {
  try {
    const resp = await fetch("/api/overview");
    overviewData = await resp.json();

    setText("kpi-total-units", fmt(overviewData.total_units));
    setText("kpi-expiry",      fmt(overviewData.near_expiry_units));
    setText("kpi-critical",    fmt(overviewData.critical_inventory_count));
    setText("kpi-transfers",   fmt(overviewData.transfer_opportunities));
    setText("last-updated-text", "Updated " + overviewData.last_updated);

    renderAlertsSidebar(overviewData);
    buildAlertBanner(overviewData);
  } catch(e) {
    console.error("Overview load failed:", e);
  }
}

function buildAlertBanner(data) {
  const items = [];
  data.expiry_warnings.forEach(w => {
    items.push(`EXPIRY ALERT: ${w.blood_type} at ${w.hospital} — ${w.units} units expire in ${w.days_until_expiry} day(s)`);
  });
  data.low_inventory_warnings.forEach(w => {
    items.push(`LOW STOCK: ${w.blood_type} at ${w.hospital} — only ${w.units} units (${w.days_of_supply} days supply)`);
  });

  if (items.length === 0) return;

  // Duplicate text for seamless marquee loop
  const fullText = items.join("   •   ");
  el("alert-text").textContent = fullText + "   •   " + fullText;
  el("alert-banner").classList.remove("hidden");
}

function renderAlertsSidebar(data) {
  const alertsList  = el("alerts-list");
  const expiryList  = el("expiry-list");
  const alertBadge  = el("alert-count");
  const expiryBadge = el("expiry-count");

  const low = data.low_inventory_warnings;
  alertBadge.textContent = low.length;

  if (low.length === 0) {
    alertsList.innerHTML = '<div class="empty-state-sm">No low-stock alerts</div>';
  } else {
    alertsList.innerHTML = low.map(w => `
      <div class="alert-item">
        <span class="alert-dot" style="background:${w.days_of_supply < 3 ? "var(--red)" : "var(--amber)"}"></span>
        <div class="alert-content">
          <div class="alert-hospital">${w.blood_type} — ${w.hospital.split(" ")[0]}…</div>
          <div class="alert-detail">${w.units} units · ${w.days_of_supply}d supply</div>
        </div>
      </div>
    `).join("");
  }

  const exp = data.expiry_warnings;
  expiryBadge.textContent = exp.length;

  if (exp.length === 0) {
    expiryList.innerHTML = '<div class="empty-state-sm">No near-expiry alerts</div>';
  } else {
    expiryList.innerHTML = exp.map(w => `
      <div class="alert-item">
        <span class="alert-dot" style="background:${w.days_until_expiry <= 2 ? "var(--red)" : "var(--amber)"}"></span>
        <div class="alert-content">
          <div class="alert-hospital">${w.blood_type} — ${w.hospital.split(" ")[0]}…</div>
          <div class="alert-detail">${w.units} units · expires in ${w.days_until_expiry}d</div>
        </div>
      </div>
    `).join("");
  }
}


// ---------------------------------------------------------------------------
// HOSPITAL DASHBOARD
// ---------------------------------------------------------------------------

async function loadDashboard(hospitalName) {
  if (!hospitalName) return;

  setText("hospital-name-display", hospitalName);

  try {
    const resp = await fetch(`/api/hospital/${encodeURIComponent(hospitalName)}`);
    const data = await resp.json();
    if (data.error) return;

    renderBloodTypeGrid(data.inventory, hospitalName);
  } catch(e) {
    console.error("Dashboard load failed:", e);
  }
}

function renderBloodTypeGrid(inventory, hospitalName) {
  const grid = el("blood-type-grid");
  if (!inventory || inventory.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No inventory data available.</p></div>';
    return;
  }

  // Sort: critical first, then by shortage score desc
  inventory.sort((a, b) => {
    const statusOrder = { critical: 0, high_risk: 1, warning: 2, stable: 3 };
    return (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4)
      || b.shortage_score - a.shortage_score;
  });

  grid.innerHTML = inventory.map(item => {
    const barW    = supplyBarWidth(item.days_of_supply);
    const barColor = supplyBarColor(item.status);
    const badges  = [];

    if (item.near_expiry_flag)
      badges.push(`<span class="badge badge-amber">Expiring Soon</span>`);
    if (item.low_stock_flag)
      badges.push(`<span class="badge badge-red">Low Stock</span>`);
    if (item.status === "stable" && !item.near_expiry_flag)
      badges.push(`<span class="badge badge-green">Adequate</span>`);

    return `
      <div class="bt-card status-${item.status}">
        <div class="bt-type-label">${item.blood_type}</div>
        <div>
          <span class="bt-units">${fmt(item.total_units)}</span>
          <span class="bt-units-label"> units</span>
        </div>
        <div class="supply-bar-track">
          <div class="supply-bar-fill" style="width:${barW}%;background:${barColor}"></div>
        </div>
        <div class="bt-meta">
          <div class="bt-meta-row">
            <span class="bt-meta-key">Daily usage</span>
            <span class="bt-meta-val">${item.daily_usage}u/day</span>
          </div>
          <div class="bt-meta-row">
            <span class="bt-meta-key">Days supply</span>
            <span class="bt-meta-val" style="color:${barColor}">${item.days_of_supply}d</span>
          </div>
          <div class="bt-meta-row">
            <span class="bt-meta-key">Nearest expiry</span>
            <span class="bt-meta-val">${item.days_until_earliest_expiry}d</span>
          </div>
          ${item.near_expiry_units > 0 ? `
          <div class="bt-meta-row">
            <span class="bt-meta-key">Near-expiry units</span>
            <span class="bt-meta-val" style="color:var(--amber)">${item.near_expiry_units}u</span>
          </div>` : ""}
        </div>
        <div class="bt-badges">${badges.join("")}</div>
        ${item.status !== "stable" ? `
        <button class="bt-transfer-btn" onclick="requestTransfer('${item.blood_type}', '${hospitalName}')">
          Find Transfer Partner
        </button>` : ""}
      </div>
    `;
  }).join("");
}

// Called from blood type card "Find Transfer Partner" button
function requestTransfer(bloodType, hospital) {
  // Switch to Exchange tab and pre-fill the form
  const btn = document.querySelector('[data-tab="exchange"]');
  switchTab("exchange", btn);
  el("transfer-hospital").value = hospital;
  el("transfer-bt").value = bloodType;
  // Small delay for map to init, then run
  setTimeout(runTransferRecommendation, 400);
}


// ---------------------------------------------------------------------------
// EXCHANGE NETWORK — MAP
// ---------------------------------------------------------------------------

function initExchangeTab() {
  if (mapInstance) return;  // already initialised

  mapInstance = L.map("map", {
    center: [41.5, -86.0],
    zoom: 6,
    zoomControl: true,
  });

  // OpenStreetMap tiles (dark filter applied via CSS)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(mapInstance);

  loadHeatmap();
}

async function loadHeatmap() {
  try {
    const resp = await fetch("/api/heatmap");
    heatmapData = await resp.json();
    drawMapMarkers(heatmapData);
  } catch(e) {
    console.error("Heatmap load failed:", e);
  }
}

function intensityToColor(intensity) {
  if (intensity >= 0.7) return "#ff1744";
  if (intensity >= 0.45) return "#ff7043";
  if (intensity >= 0.25) return "#ffab40";
  return "#00e676";
}

function drawMapMarkers(data) {
  // Clear existing
  mapMarkers.forEach(m => m.remove());
  mapOverlays.forEach(c => c.remove());
  mapMarkers = [];
  mapOverlays = [];

  data.forEach(h => {
    const color  = intensityToColor(h.stress_intensity);
    const radius = 18000 + h.stress_intensity * 28000;  // stressed = larger circle

    // Stress halo circle
    const circle = L.circle([h.lat, h.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.12,
      weight: 1.5,
      opacity: 0.5,
    }).addTo(mapInstance);
    mapOverlays.push(circle);

    // Hospital pin (custom div icon)
    const dotColor   = color;
    const icon = L.divIcon({
      className: "",
      html: `
        <div style="
          width:14px;height:14px;
          background:${dotColor};
          border:2px solid rgba(255,255,255,0.8);
          border-radius:50%;
          box-shadow:0 0 10px ${dotColor}88;
          cursor:pointer;
        "></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    const marker = L.marker([h.lat, h.lon], { icon })
      .addTo(mapInstance)
      .bindPopup(buildMapPopup(h), { maxWidth: 240 });

    marker.on("click", () => loadHospitalDetailPanel(h.hospital));
    mapMarkers.push(marker);
  });
}

function buildMapPopup(h) {
  const stressLabel = h.stress_intensity >= 0.7 ? "Critical"
    : h.stress_intensity >= 0.45 ? "High Risk"
    : h.stress_intensity >= 0.25 ? "Warning"
    : "Stable";
  const color = intensityToColor(h.stress_intensity);

  return `
    <div style="padding:4px 2px">
      <div style="font-weight:700;font-size:14px;color:#e8f0fe;margin-bottom:6px">${h.hospital}</div>
      <div style="font-size:12px;color:#9bb8d8;margin-bottom:8px">${h.city}</div>
      <div style="display:flex;gap:8px;font-size:12px;flex-wrap:wrap">
        <span style="color:${color};font-weight:600">${stressLabel}</span>
        <span style="color:#5a7a9e">·</span>
        <span style="color:#9bb8d8">${h.total_units} units</span>
      </div>
      <div style="font-size:11px;color:#5a7a9e;margin-top:6px">
        ${h.critical_types} critical type(s) · ${h.near_expiry_batches} near-expiry batch(es)
      </div>
      <div style="font-size:11px;color:#5a7a9e;margin-top:2px">
        Avg shortage score: ${h.avg_shortage_score.toFixed(2)}
      </div>
    </div>`;
}

async function loadHospitalDetailPanel(hospitalName) {
  try {
    const resp = await fetch(`/api/hospital/${encodeURIComponent(hospitalName)}`);
    const data = await resp.json();
    if (data.error) return;

    el("detail-hospital-name").textContent = data.name;
    el("detail-inventory").innerHTML = data.inventory.map(item => `
      <div class="detail-inv-row">
        <span class="detail-bt">${item.blood_type}</span>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="detail-units">${item.total_units}u</span>
          <span style="font-size:11px;color:${STATUS_COLORS[item.status] || '#5a7a9e'};font-weight:600"
          >${item.days_of_supply}d supply</span>
        </div>
      </div>
    `).join("");

    el("hospital-detail").classList.remove("hidden");
  } catch(e) {
    console.error("Hospital detail panel failed:", e);
  }
}

function closeHospitalDetail() {
  el("hospital-detail").classList.add("hidden");
}

async function filterMapByBloodType(bt, btn) {
  // Update pill UI
  document.querySelectorAll(".bt-pill").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");

  if (bt === "ALL") {
    drawMapMarkers(heatmapData);
    return;
  }

  try {
    const resp = await fetch(`/api/blood-types?type=${encodeURIComponent(bt)}`);
    const data = await resp.json();

    // Redraw markers colored by this blood type's status at each hospital
    mapMarkers.forEach(m => m.remove());
    mapOverlays.forEach(c => c.remove());
    mapMarkers = [];
    mapOverlays = [];

    const hospitalStatusMap = {};
    data.forEach(h => { hospitalStatusMap[h.hospital] = h; });

    heatmapData.forEach(h => {
      const info  = hospitalStatusMap[h.hospital];
      const color = info ? STATUS_COLORS[info.status] || "#7a9cc0" : "#2e4a6a";
      const radius = 18000 + (info ? (4 - (info.days_of_supply > 30 ? 3 : info.days_of_supply > 10 ? 2 : 1)) * 8000 : 0);

      const circle = L.circle([h.lat, h.lon], {
        radius,
        color, fillColor: color, fillOpacity: 0.15, weight: 1.5, opacity: 0.6,
      }).addTo(mapInstance);
      mapOverlays.push(circle);

      const icon = L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;background:${color};border:2px solid rgba(255,255,255,0.8);border-radius:50%;box-shadow:0 0 10px ${color}88;cursor:pointer"></div>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
      });

      const units      = info ? info.units : 0;
      const daysSupply = info ? info.days_of_supply : 0;

      const marker = L.marker([h.lat, h.lon], { icon })
        .addTo(mapInstance)
        .bindPopup(`
          <div style="padding:4px 2px">
            <div style="font-weight:700;font-size:14px;color:#e8f0fe;margin-bottom:6px">${h.hospital}</div>
            <div style="font-size:12px;color:#9bb8d8;margin-bottom:8px">${h.city}</div>
            <div style="font-size:13px"><span style="font-family:monospace;font-weight:700;color:#e8f0fe">${bt}</span></div>
            <div style="font-size:12px;color:${color};font-weight:600;margin-top:4px">${units} units · ${daysSupply}d supply</div>
          </div>
        `, { maxWidth: 200 });

      marker.on("click", () => loadHospitalDetailPanel(h.hospital));
      mapMarkers.push(marker);
    });
  } catch(e) {
    console.error("Blood type filter failed:", e);
  }
}


// ---------------------------------------------------------------------------
// TRANSFER RECOMMENDATION
// ---------------------------------------------------------------------------

async function runTransferRecommendation() {
  const hospital   = el("transfer-hospital").value;
  const blood_type = el("transfer-bt").value;

  if (!hospital || !blood_type) {
    alert("Please select both a hospital and blood type.");
    return;
  }

  try {
    const resp = await fetch("/api/transfer-recommendation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hospital, blood_type }),
    });
    const data = await resp.json();

    if (data.error) {
      el("transfer-best").innerHTML = `<p style="color:var(--text-3);padding:12px 0;font-size:13px">${data.error}</p>`;
      el("transfer-results").classList.remove("hidden");
      return;
    }

    renderTransferResults(data);

    // Draw a line on the map from requester to best partner
    if (transferLine) transferLine.remove();
    const reqHosp = heatmapData.find(h => h.hospital === hospital);
    const bestHosp = data.closest || data.highest_stock;
    if (reqHosp && bestHosp) {
      const partnerData = heatmapData.find(h => h.hospital === bestHosp.hospital);
      if (partnerData) {
        transferLine = L.polyline(
          [[reqHosp.lat, reqHosp.lon], [partnerData.lat, partnerData.lon]],
          { color: "#00d4ff", weight: 2.5, dashArray: "6 4", opacity: 0.8 }
        ).addTo(mapInstance);
        mapInstance.fitBounds(transferLine.getBounds(), { padding: [40, 40] });
      }
    }
  } catch(e) {
    console.error("Transfer recommendation failed:", e);
  }
}

function renderTransferResults(data) {
  const { closest, highest_stock, candidates } = data;

  let bestHTML = "";

  if (closest) {
    bestHTML += `
      <div class="transfer-card best">
        <div class="transfer-card-label">Best Overall (Closest)</div>
        <div class="transfer-hospital-name">${closest.hospital}</div>
        <div class="transfer-stats">
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">City</span>
            <span class="transfer-stat-val">${closest.city}, ${closest.state}</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Distance</span>
            <span class="transfer-stat-val">${closest.distance_km} km</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Est. transfer</span>
            <span class="transfer-stat-val">${closest.estimated_transfer_hours}h ground</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Available ${data.blood_type}</span>
            <span class="transfer-stat-val good">${closest.total_units} units</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Transferable</span>
            <span class="transfer-stat-val good">${closest.transferable_units} units</span>
          </div>
        </div>
      </div>`;
  }

  if (highest_stock && highest_stock.hospital !== closest?.hospital) {
    bestHTML += `
      <div class="transfer-card">
        <div class="transfer-card-label">Highest Stock</div>
        <div class="transfer-hospital-name">${highest_stock.hospital}</div>
        <div class="transfer-stats">
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Distance</span>
            <span class="transfer-stat-val">${highest_stock.distance_km} km</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Est. transfer</span>
            <span class="transfer-stat-val">${highest_stock.estimated_transfer_hours}h</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Available</span>
            <span class="transfer-stat-val good">${highest_stock.total_units} units</span>
          </div>
        </div>
      </div>`;
  }

  el("transfer-best").innerHTML = bestHTML;

  // All candidates list (condensed)
  if (candidates && candidates.length > 2) {
    let allHTML = `<div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin:8px 0 6px">All Candidates</div>`;
    candidates.slice(0, 5).forEach(c => {
      allHTML += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">
          <div>
            <div style="color:var(--text-1);font-weight:500">${c.hospital.split(" ")[0]}…</div>
            <div style="color:var(--text-3);font-size:11px">${c.distance_km}km · ${c.estimated_transfer_hours}h</div>
          </div>
          <span style="color:var(--green);font-weight:600;font-size:13px;font-family:monospace">${c.total_units}u</span>
        </div>`;
    });
    el("transfer-all").innerHTML = allHTML;
  } else {
    el("transfer-all").innerHTML = "";
  }

  el("transfer-results").classList.remove("hidden");
}


// ---------------------------------------------------------------------------
// AI PREDICTIONS
// ---------------------------------------------------------------------------

let allPredictions = [];

async function loadPredictions() {
  if (allPredictions.length > 0) return;  // already loaded

  el("predictions-list").innerHTML = '<div class="empty-state"><p>Loading AI predictions...</p></div>';

  try {
    const resp = await fetch("/api/predictions");
    const data = await resp.json();

    allPredictions = data.predictions;

    // Update summary cards
    setText("risk-stable",    data.summary.stable);
    setText("risk-watchlist", data.summary.watchlist);
    setText("risk-high",      data.summary.high_risk);
    setText("risk-critical",  data.summary.critical);

    // Render prediction list
    renderPredictionList("all");

    // Risk doughnut chart
    buildRiskDoughnut(data.summary);

    // Feature importance
    renderFeatureImportance(data.feature_importance || []);
  } catch(e) {
    console.error("Predictions load failed:", e);
    el("predictions-list").innerHTML = '<div class="empty-state"><p>Failed to load predictions.</p></div>';
  }
}

function filterPredictions(filter, btn) {
  document.querySelectorAll(".pred-filter").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderPredictionList(filter);
}

function renderPredictionList(filter) {
  let items = allPredictions;
  if (filter !== "all") {
    items = allPredictions.filter(p => p.risk_level === parseInt(filter));
  }

  if (items.length === 0) {
    el("predictions-list").innerHTML = '<div class="empty-state"><p>No predictions in this category.</p></div>';
    return;
  }

  el("predictions-list").innerHTML = items.map(p => {
    const btBg     = p.risk_level === 3 ? "rgba(255,23,68,0.15)" : p.risk_level === 2 ? "rgba(255,112,67,0.15)" : p.risk_level === 1 ? "rgba(255,171,64,0.15)" : "rgba(0,230,118,0.12)";
    const btColor  = RISK_COLORS[p.risk_level];
    const confidence = Math.round(p.confidence * 100);

    return `
      <div class="pred-card" data-risk="${p.risk_level}">
        <div class="pred-bt-badge" style="background:${btBg};color:${btColor}">
          ${p.blood_type}
        </div>
        <div class="pred-main">
          <div class="pred-hospital">${p.hospital}</div>
          <div class="pred-city">${p.season} season · Surgery load: ${p.surgery_score}/10 · Trauma: ${p.trauma_rate}/10</div>
          <div class="pred-explanation">${p.explanation}</div>
        </div>
        <div class="pred-meta">
          ${riskBadgeHTML(p.risk_level)}
          <div class="pred-stats">
            ${p.total_units}u available<br>
            ${p.days_of_supply}d supply<br>
            ${confidence}% confidence
          </div>
        </div>
      </div>`;
  }).join("");
}

function buildRiskDoughnut(summary) {
  destroyChart("riskDoughnut");
  const ctx = el("risk-doughnut-chart");
  if (!ctx) return;

  charts["riskDoughnut"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Stable", "Watchlist", "High Risk", "Critical"],
      datasets: [{
        data: [summary.stable, summary.watchlist, summary.high_risk, summary.critical],
        backgroundColor: ["#00e67630", "#ffab4030", "#ff704330", "#ff174430"],
        borderColor:     ["#00e676",   "#ffab40",   "#ff7043",   "#ff1744"],
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#9bb8d8", font: { size: 11, family: "Inter" }, padding: 12, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: "#0d1530",
          borderColor: "#1a2d50",
          borderWidth: 1,
          titleColor: "#e8f0fe",
          bodyColor: "#9bb8d8",
        },
      },
    },
  });
}

function renderFeatureImportance(features) {
  const list = el("feature-importance-list");
  if (!features.length) { list.innerHTML = ""; return; }

  const top = features.slice(0, 7);
  const maxImp = top[0]?.importance || 1;

  const FRIENDLY_NAMES = {
    shortage_score_7d:    "7-Day Shortage Score",
    days_of_supply:       "Days of Supply",
    units_available:      "Units Available",
    near_expiry_fraction: "Near-Expiry Fraction",
    daily_usage:          "Daily Usage Rate",
    trauma_rate:          "Trauma Rate",
    surgery_schedule_score: "Surgery Schedule",
    demand_pressure:      "Demand Pressure",
    days_until_expiry:    "Days Until Expiry",
    historical_demand:    "Historical Demand",
    season_enc:           "Seasonality",
  };

  list.innerHTML = top.map(f => {
    const pct  = Math.round((f.importance / maxImp) * 100);
    const name = FRIENDLY_NAMES[f.feature] || f.feature;
    return `
      <div class="fi-item">
        <div class="fi-label">${name}<span>${(f.importance * 100).toFixed(1)}%</span></div>
        <div class="fi-track"><div class="fi-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}


// ---------------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------------

async function loadAnalytics() {
  if (charts["inventory"]) return;  // already loaded

  try {
    const resp = await fetch("/api/analytics");
    const data = await resp.json();

    setText("an-total-inv",   fmt(data.total_inventory));
    setText("an-expiry-risk", fmt(data.units_at_expiry_risk));
    setText("an-stressed",    fmt(data.hospitals_under_stress));
    setText("an-coverage",    data.inventory_days_coverage + "d");

    buildInventoryChart(data);
    buildDemandTrendChart(data);
    buildStressTable(data.hospital_stress);
  } catch(e) {
    console.error("Analytics load failed:", e);
  }
}

function buildInventoryChart(data) {
  destroyChart("inventory");
  const ctx = el("inventory-chart");
  if (!ctx) return;

  const types  = Object.keys(data.blood_type_inventory).sort();
  const stocks = types.map(t => data.blood_type_inventory[t]);
  const usages = types.map(t => Math.round((data.blood_type_daily_usage[t] || 0) * 7));

  charts["inventory"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: types,
      datasets: [
        {
          label: "Units in Stock",
          data: stocks,
          backgroundColor: "rgba(0,212,255,0.2)",
          borderColor: "#00d4ff",
          borderWidth: 1.5,
          borderRadius: 4,
        },
        {
          label: "7-Day Demand",
          data: usages,
          backgroundColor: "rgba(255,23,68,0.2)",
          borderColor: "#ff1744",
          borderWidth: 1.5,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#9bb8d8", font: { size: 11, family: "Inter" } } },
        tooltip: { backgroundColor: "#0d1530", borderColor: "#1a2d50", borderWidth: 1, titleColor: "#e8f0fe", bodyColor: "#9bb8d8" },
      },
      scales: {
        x: { grid: { color: "#1a2d5040" }, ticks: { color: "#5a7a9e", font: { family: "JetBrains Mono", size: 12 } } },
        y: { grid: { color: "#1a2d5040" }, ticks: { color: "#5a7a9e", font: { family: "Inter", size: 11 } } },
      },
    },
  });
}

function buildDemandTrendChart(data) {
  destroyChart("demandTrend");
  const ctx = el("demand-trend-chart");
  if (!ctx) return;

  const weeks  = ["Wk -7", "Wk -6", "Wk -5", "Wk -4", "Wk -3", "Wk -2", "Last Wk", "Current"];
  const colors = { "O+": "#ff5252", "O-": "#ff1744", "A+": "#00d4ff", "B+": "#7c3aed" };

  const datasets = Object.entries(data.weekly_demand_trends).map(([bt, vals]) => ({
    label: bt,
    data: vals,
    borderColor: colors[bt] || "#7a9cc0",
    backgroundColor: (colors[bt] || "#7a9cc0") + "15",
    fill: true,
    tension: 0.4,
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
  }));

  charts["demandTrend"] = new Chart(ctx, {
    type: "line",
    data: { labels: weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#9bb8d8", font: { size: 11, family: "Inter" } } },
        tooltip: { backgroundColor: "#0d1530", borderColor: "#1a2d50", borderWidth: 1, titleColor: "#e8f0fe", bodyColor: "#9bb8d8", mode: "index", intersect: false },
      },
      scales: {
        x: { grid: { color: "#1a2d5040" }, ticks: { color: "#5a7a9e", font: { size: 11 } } },
        y: { grid: { color: "#1a2d5040" }, ticks: { color: "#5a7a9e", font: { size: 11 } } },
      },
    },
  });
}

function buildStressTable(hospitals) {
  const container = el("hospital-stress-table");
  if (!container) return;

  const maxScore = Math.max(...hospitals.map(h => h.avg_shortage_score), 1);

  let html = `
    <div class="stress-row header">
      <span>Hospital</span>
      <span>Units</span>
      <span>Near Expiry</span>
      <span>Shortage Score</span>
      <span>Status</span>
    </div>`;

  html += hospitals.map(h => {
    const barW  = Math.round((h.avg_shortage_score / maxScore) * 100);
    const color = h.stress_level === "critical" ? "#ff1744" : h.stress_level === "warning" ? "#ffab40" : "#00e676";

    return `
      <div class="stress-row">
        <div>
          <div class="stress-hospital">${h.hospital}</div>
          <div class="stress-city">${h.city}</div>
        </div>
        <span class="stress-val">${fmt(h.total_units)}</span>
        <span class="stress-val" style="color:${h.near_expiry_units > 0 ? 'var(--amber)' : 'var(--text-3)'}">${h.near_expiry_units}</span>
        <div class="stress-bar-cell">
          <div style="font-size:12px;color:${color};margin-bottom:4px;font-weight:600">${h.avg_shortage_score.toFixed(2)}</div>
          <div class="stress-bar-track">
            <div class="stress-bar-fill" style="width:${barW}%;background:${color}"></div>
          </div>
        </div>
        <span class="status-pill ${h.stress_level}">${h.stress_level.replace("_", " ")}</span>
      </div>`;
  }).join("");

  container.innerHTML = html;
}
