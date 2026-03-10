/**
 * script.js — bloodBridge Frontend
 *
 * Handles:
 *   - Login / role-aware app entry (staff vs donor)
 *   - Tab switching with lazy-load
 *   - Dashboard: hospital inventory cards + alert sidebar
 *   - Donor Hub: blood type priority, urgent needs, nearest centers, CTA
 *   - Exchange Network: Leaflet map (+ Google Maps when key is set) + transfer tool
 *   - AI Predictions: risk cards + doughnut chart + feature importance
 *   - Analytics: Chart.js charts + hospital stress table
 *
 * Google Maps integration:
 *   Set GOOGLE_MAPS_API_KEY env var in the backend. When the key is present,
 *   the template loads the Maps JS API and calls initGoogleMap() as callback.
 *   All map functionality routes through the active map adapter automatically.
 */

"use strict";

//global state
let currentUser     = null;
let currentHospital = null;
let donorBloodType  = null;
let isDonorRole     = false;
let allHospitals    = [];
let overviewData    = null;
let predictionData  = [];
let charts          = {};

// Map state
let mapInitialized = false;
let mapInstance    = null;    // Leaflet map
let googleMap      = null;    // Google Maps instance
let mapMarkers     = [];
let mapOverlays    = [];
let heatmapData    = [];
let transferLine   = null;
let pendingHeatmap = false;   // true if heatmap loaded before Google Maps ready

//Constants
const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const STATUS_COLORS = {
  stable:    "#00e676",
  warning:   "#ffab40",
  high_risk: "#ff7043",
  critical:  "#ff1744",
};

const RISK_COLORS = {
  0: "#00e676", 1: "#ffab40", 2: "#ff7043", 3: "#ff1744",
};

const RISK_LABELS = {
  0: "Stable", 1: "Watchlist", 2: "High Risk", 3: "Critical",
};

// Pure black theme for Google Maps
const GOOGLE_MAPS_DARK_STYLE = [
  { elementType: "geometry",           stylers: [{ color: "#000000" }] },
  { elementType: "labels.icon",        stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill",   stylers: [{ color: "#c8daf0" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#000000" }] },
  { featureType: "administrative",     elementType: "geometry", stylers: [{ color: "#1a1a1a" }] },
  { featureType: "poi",                stylers: [{ visibility: "off" }] },
  { featureType: "road",               elementType: "geometry",        stylers: [{ color: "#1a1a1a" }] },
  { featureType: "road",               elementType: "geometry.stroke",  stylers: [{ color: "#0d0d0d" }] },
  { featureType: "road.highway",       elementType: "geometry",        stylers: [{ color: "#2a2a2a" }] },
  { featureType: "transit",            stylers: [{ visibility: "off" }] },
  { featureType: "water",              elementType: "geometry",        stylers: [{ color: "#000000" }] },
];

// Northeast map center
const NE_CENTER_LEAFLET  = [42.2, -72.8];
const NE_CENTER_GOOGLE   = { lat: 42.2, lng: -72.8 };
const NE_ZOOM            = 7;


//Utility Helpers
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }
function fmt(n) { return typeof n === "number" ? n.toLocaleString("en-US") : n; }

function statusBadgeHTML(status) {
  const labels = { stable: "Stable", warning: "Warning", high_risk: "High Risk", critical: "Critical" };
  const cls    = { stable: "badge-green", warning: "badge-amber", high_risk: "badge-amber", critical: "badge-red" };
  return `<span class="badge ${cls[status] || "badge-blue"}">${labels[status] || status}</span>`;
}

function riskBadgeHTML(riskLevel) {
  const bgMap  = { 0: "rgba(0,230,118,0.15)",  1: "rgba(255,171,64,0.15)", 2: "rgba(255,112,67,0.15)", 3: "rgba(255,23,68,0.15)" };
  const bdrMap = { 0: "rgba(0,230,118,0.3)",   1: "rgba(255,171,64,0.3)", 2: "rgba(255,112,67,0.3)",  3: "rgba(255,23,68,0.3)" };
  return `<span class="risk-badge"
    style="background:${bgMap[riskLevel]};color:${RISK_COLORS[riskLevel]};border:1px solid ${bdrMap[riskLevel]}"
  >${RISK_LABELS[riskLevel]}</span>`;
}

function supplyBarColor(status) { return STATUS_COLORS[status] || "#7a9cc0"; }
function supplyBarWidth(days)   { return Math.min(100, Math.round((days / 30) * 100)); }

function destroyChart(key) {
  if (charts[key]) { try { charts[key].destroy(); } catch (e) {} delete charts[key]; }
}

function kmToMi(km) { return (km * 0.621371).toFixed(1); }
function fmtTransport(hours) {
  const mins = Math.round(hours * 60);
  return mins <= 59 ? `${mins} min` : `${(mins / 60).toFixed(1)} hr`;
}

function intensityToColor(intensity) {
  if (intensity >= 0.7)  return "#ff1744";
  if (intensity >= 0.45) return "#ff7043";
  if (intensity >= 0.25) return "#ffab40";
  return "#00e676";
}


// AUTH — Landing page modals + session handling
function applySession(user) {
  currentUser     = user;
  isDonorRole     = user.role === "Donor";
  donorBloodType  = isDonorRole ? (user.donor_blood_type || null) : null;
  currentHospital = isDonorRole ? null : (user.hospital || null);

  setText("user-name-display", user.name);
  setText("user-role-display", user.role);
  const avatar = el("user-avatar");
  if (avatar) avatar.textContent = user.name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
}

function showApp() {
  const overlay = el("login-overlay");
  if (overlay) {
    overlay.style.transition = "opacity 0.45s ease";
    overlay.style.opacity    = "0";
    setTimeout(() => { overlay.style.display = "none"; }, 460);
  }
  const app = el("app");
  if (app) {
    app.classList.remove("hidden");
    app.style.opacity = "0";
    setTimeout(() => {
      app.style.transition = "opacity 0.38s ease";
      app.style.opacity    = "1";
    }, 60);
  }
}

// Login overlay — role field toggles
function handleRoleChange(role) {
  const hf = el("hospital-field");
  const bf = el("donor-bt-field");
  if (hf) hf.style.display = role === "Donor" ? "none" : "block";
  if (bf) bf.style.display = role === "Donor" ? "block" : "none";
}

// Login form submit
document.addEventListener("DOMContentLoaded", () => {
  const form = el("login-form");
  if (!form) return;
  form.addEventListener("submit", async function(e) {
    e.preventDefault();
    const name    = (el("login-name")?.value    || "").trim();
    const role    = el("login-role")?.value     || "";
    const hosp    = el("login-hospital")?.value || "";
    const donorBT = el("login-donor-bt")?.value || "";
    const btn     = el("btn-enter-text");

    if (!name || !role) { alert("Please enter your name and select a role."); return; }
    if (role !== "Donor" && !hosp) { alert("Please select your hospital."); return; }
    if (role === "Donor" && !donorBT) { alert("Please select your blood type."); return; }
    if (btn) btn.textContent = "Entering…";

    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role, hospital: hosp, donor_blood_type: donorBT }),
      });
      const d = await r.json();
      if (d.success) {
        applySession({ name, role, hospital: hosp, donor_blood_type: donorBT });
        showApp();
        bootApp();
      } else {
        if (btn) btn.textContent = "Enter Platform";
        alert(d.error || "Login failed.");
      }
    } catch(ex) {
      if (btn) btn.textContent = "Enter Platform";
      alert("Network error — is the server running?");
    }
  });
});

async function doLogout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch(e) {}
  // Reset state
  currentUser     = null;
  currentHospital = null;
  isDonorRole     = false;
  donorBloodType  = null;
  allPredictions  = [];
  predLoadAttempt = 0;
  donorDataLoaded = false;
  mapInitialized  = false;
  if (mapInstance)  { try { mapInstance.remove(); } catch(e){} mapInstance = null; }
  googleMap = null;
  Object.keys(charts).forEach(k => destroyChart(k));
  // Reset UI
  const app = el("app");
  if (app) { app.classList.add("hidden"); app.style.opacity = ""; }
  const overlay = el("login-overlay");
  if (overlay) { overlay.style.display = ""; overlay.style.opacity = "1"; }
  const form = el("login-form");
  if (form) form.reset();
  handleRoleChange("");
}

// Pre-load hospitals AND handle session auto-login (order matters: hospitals first)
(async function initAll() {
  try {
    const resp   = await fetch("/api/hospitals");
    allHospitals = await resp.json();

    // Populate login overlay hospital select
    const loginSel = el("login-hospital");
    if (loginSel) {
      loginSel.innerHTML = '<option value="" disabled selected>Select your hospital</option>';
      allHospitals.forEach(h => {
        const opt = document.createElement("option");
        opt.value       = h.name;
        opt.textContent = `${h.name} — ${h.city}, ${h.state}`;
        loginSel.appendChild(opt);
      });
    }

    // Populate home tab stat
    const total = allHospitals.reduce((s, h) => s + h.total_units, 0);
    const su = el("home-stat-units");
    if (su) su.textContent = total.toLocaleString("en-US");
  } catch (e) {
    console.warn("Could not preload hospitals:", e);
  }

  // Session auto-login — AFTER hospitals are loaded to fix race condition
  if (window.SESSION_USER && !currentUser) {
    applySession(window.SESSION_USER);
    showApp();
    bootApp();
  }
})();

// BOOT
async function bootApp() {
  if (isDonorRole) {
    // Show donor header, hide hospital selector
    el("header-center-staff").classList.add("hidden");
    el("header-center-donor").classList.remove("hidden");
    setText("donor-bt-indicator", donorBloodType || "?");

    // Navigate to Donor tab by default
    const donorBtn = el("donor-tab-btn");
    switchTab("donor", donorBtn);
    return; // skip home tab init for donors
  } else {
    // Staff: populate hospital selector
    const sel = el("hospital-selector");
    sel.innerHTML = "";
    allHospitals.forEach(h => {
      const opt = document.createElement("option");
      opt.value       = h.name;
      opt.textContent = `${h.name} — ${h.city}, ${h.state}`;
      sel.appendChild(opt);
    });
    if (currentHospital) sel.value = currentHospital;

    sel.addEventListener("change", function () {
      currentHospital = this.value;
      loadDashboard(currentHospital);
    });
  }

  // Populate transfer hospital selector
  const tSel = el("transfer-hospital");
  allHospitals.forEach(h => {
    const opt = document.createElement("option");
    opt.value       = h.name;
    opt.textContent = `${h.name} — ${h.city}, ${h.state}`;
    tSel.appendChild(opt);
  });
  if (currentHospital) tSel.value = currentHospital;

  // Load overview for KPIs + alert banner
  await loadOverview();

  // Load dashboard for selected hospital (staff only)
  if (!isDonorRole && currentHospital) {
    await loadDashboard(currentHospital);
  }

  // Default to Home tab for staff
  if (!isDonorRole) {
    const homeBtn = document.querySelector('[data-tab="home"]');
    switchTab("home", homeBtn);
  }
}


// TAB SWITCHING
function switchTab(tabId, btn) {
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.remove("active");
    p.classList.remove("hidden");
  });
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));

  const panel = el(`tab-${tabId}`);
  if (panel) panel.classList.add("active");
  if (btn)   btn.classList.add("active");

  // Lazy-load tab content
  if (tabId === "home")        initHomeTab();
  if (tabId === "donor")       loadDonorDashboard();
  if (tabId === "exchange")    initExchangeTab();
  if (tabId === "predictions") loadPredictions();
  if (tabId === "analytics")   loadAnalytics();
}


// OVERVIEW (KPIs + Banner)
async function loadOverview() {
  try {
    const resp   = await fetch("/api/overview");
    overviewData = await resp.json();

    // Summary banner chips
    setText("sb-critical",  overviewData.critical_inventory_count);
    setText("sb-expiry",    fmt(overviewData.near_expiry_units));
    setText("sb-transfers", overviewData.transfer_opportunities);
    setText("sb-units",     fmt(overviewData.total_units));
    setText("last-updated-text", "Updated " + overviewData.last_updated);

    // Alert bell badge
    const totalAlerts = (overviewData.low_inventory_warnings || []).length +
                        (overviewData.expiry_warnings || []).length;
    const bellCount = el("alert-bell-count");
    if (totalAlerts > 0) {
      bellCount.textContent = totalAlerts > 9 ? "9+" : totalAlerts;
      bellCount.style.display = "flex";
    }

    renderAlertsSidebar(overviewData);
    buildAlertPanel(overviewData);
  } catch (e) {
    console.error("Overview load failed:", e);
  }
}

function buildAlertPanel(data) {
  const list = el("alert-panel-list");
  if (!list) return;
  const allItems = [];
  (data.expiry_warnings || []).forEach(w => {
    allItems.push({ type: "expiry", w });
  });
  (data.low_inventory_warnings || []).forEach(w => {
    allItems.push({ type: "low", w });
  });
  if (!allItems.length) {
    list.innerHTML = '<div class="empty-state-sm">No active alerts</div>';
    return;
  }
  list.innerHTML = allItems.slice(0, 12).map(({ type, w }) => {
    const isExpiry = type === "expiry";
    const color    = isExpiry ? "var(--amber)" : "var(--red)";
    const label    = isExpiry
      ? `${w.blood_type} — expires in ${w.days_until_expiry}d · ${w.units} units`
      : `${w.blood_type} — ${w.units} units (${w.days_of_supply}d supply)`;
    return `
      <div class="alert-panel-item">
        <span class="alert-dot" style="background:${color}"></span>
        <div class="alert-panel-content">
          <div class="alert-hospital">${w.hospital}</div>
          <div class="alert-detail">${label}</div>
          <div class="alert-actions">
            <button class="alert-action-btn" onclick="requestTransfer('${w.blood_type}','${w.hospital.replace(/'/g,"\\'")}')">View transfer options</button>
          </div>
        </div>
      </div>`;
  }).join("");
}

function toggleAlertPanel() {
  el("alert-panel").classList.toggle("hidden");
}

function renderAlertsSidebar(data) {
  const low = data.low_inventory_warnings || [];
  const exp = data.expiry_warnings        || [];

  setText("alert-count",  low.length);
  setText("expiry-count", exp.length);

  el("alerts-list").innerHTML = low.length === 0
    ? '<div class="empty-state-sm">No low-stock alerts</div>'
    : low.map(w => `
        <div class="alert-item">
          <span class="alert-dot" style="background:${w.days_of_supply < 3 ? "var(--red)" : "var(--amber)"}"></span>
          <div class="alert-content">
            <div class="alert-hospital"><span class="alert-bt-pill">${w.blood_type}</span> ${w.hospital}</div>
            <div class="alert-detail">${w.units} units · ${w.days_of_supply}d supply</div>
            <div class="alert-quick-actions">
              <button class="alert-action-btn" onclick="requestTransfer('${w.blood_type}','${w.hospital.replace(/'/g,"\\'")}')">View transfer options</button>
            </div>
          </div>
        </div>`).join("");

  el("expiry-list").innerHTML = exp.length === 0
    ? '<div class="empty-state-sm">No near-expiry alerts</div>'
    : exp.map(w => `
        <div class="alert-item">
          <span class="alert-dot" style="background:${w.days_until_expiry <= 2 ? "var(--red)" : "var(--amber)"}"></span>
          <div class="alert-content">
            <div class="alert-hospital"><span class="alert-bt-pill">${w.blood_type}</span> ${w.hospital}</div>
            <div class="alert-detail">${w.units} units · expires in ${w.days_until_expiry}d</div>
            <div class="alert-quick-actions">
              <button class="alert-action-btn" onclick="requestTransfer('${w.blood_type}','${w.hospital.replace(/'/g,"\\'")}')">Request transfer</button>
            </div>
          </div>
        </div>`).join("");
}

function switchSidebarTab(tab) {
  const isLow = tab === "low-stock";
  el("tab-low-stock").classList.toggle("active", isLow);
  el("tab-near-expiry").classList.toggle("active", !isLow);
  el("alerts-list").style.display  = isLow ? "block" : "none";
  el("expiry-list").style.display  = isLow ? "none"  : "block";
}



// HOSPITAL DASHBOARD (staff)
async function loadDashboard(hospitalName) {
  if (!hospitalName) return;
  setText("hospital-name-display", hospitalName);
  try {
    const resp = await fetch(`/api/hospital/${encodeURIComponent(hospitalName)}`);
    const data = await resp.json();
    if (data.error) return;
    renderBloodTypeGrid(data.inventory, hospitalName);
  } catch (e) {
    console.error("Dashboard load failed:", e);
  }
}

function buildBTCard(item, hospitalName) {
  const barW        = supplyBarWidth(item.days_of_supply);
  const barClr      = supplyBarColor(item.status);
  const statusLabel = { stable:"Adequate", warning:"Low Stock", high_risk:"High Risk", critical:"Critical" }[item.status] || item.status;
  return `
    <div class="bt-card status-${item.status}">
      <div class="bt-card-top">
        <span class="bt-type-label">${item.blood_type}</span>
        <span class="bt-status-chip chip-${item.status}">${statusLabel}</span>
      </div>
      <div class="bt-units-row">
        <span class="bt-units">${fmt(item.total_units)}</span>
        <span class="bt-units-label">units</span>
      </div>
      <div class="supply-bar-track" title="Days of supply remaining (${item.days_of_supply} days)">
        <div class="supply-bar-fill" style="width:${barW}%;background:${barClr}"></div>
      </div>
      <div class="bt-footer">
        <span class="bt-footer-key" title="Average daily blood usage rate">${item.daily_usage}u/day</span>
        <span class="bt-footer-val" style="color:${barClr}" title="Estimated days until stock is depleted">${item.days_of_supply}d supply</span>
      </div>
      ${item.near_expiry_units > 0 ? `<div class="bt-expiry-warn">⚑ ${item.near_expiry_units} units expiring soon</div>` : ""}
      ${item.status !== "stable" ? `
      <button class="bt-transfer-btn" onclick="requestTransfer('${item.blood_type}','${hospitalName.replace(/'/g,"\\'")}')">
        Request Transfer →
      </button>` : ""}
    </div>`;
}

function renderBloodTypeGrid(inventory, hospitalName) {
  const grid = el("blood-type-grid");
  if (!inventory || inventory.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No inventory data available.</p></div>';
    el("critical-section").style.display = "none";
    return;
  }

  const statusOrder = { critical: 0, high_risk: 1, warning: 2, stable: 3 };
  inventory.sort((a, b) =>
    (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4) ||
    b.shortage_score - a.shortage_score
  );

  // Critical section — show blood types needing attention
  const urgent = inventory.filter(i => i.status === "critical" || i.status === "high_risk");
  const critSection = el("critical-section");
  const critCards   = el("critical-cards");
  if (urgent.length > 0) {
    critCards.innerHTML = urgent.map(item => buildBTCard(item, hospitalName)).join("");
    critSection.style.display = "block";
  } else {
    critSection.style.display = "none";
  }

  grid.innerHTML = inventory.map(item => buildBTCard(item, hospitalName)).join("");
}

function requestTransfer(bloodType, hospital) {
  const btn = document.querySelector('[data-tab="exchange"]');
  switchTab("exchange", btn);
  el("transfer-hospital").value = hospital;
  el("transfer-bt").value       = bloodType;
  setTimeout(runTransferRecommendation, 500);
}


// DONOR HUB
let donorDataLoaded = false;
let donorData       = null;
let donorLat        = 40.7128;   // Default: NYC
let donorLon        = -74.0060;

async function loadDonorDashboard() {
  // Always reload so donor data is fresh
  try {
    const resp = await fetch("/api/donor/urgent-needs");
    donorData  = await resp.json();

    renderDonorHero(donorData);
    renderDonorBloodTypePriority(donorData.blood_type_priority || []);
    renderDonorUrgentNeeds(donorData.urgent_needs || []);
  } catch (e) {
    console.error("Donor urgent-needs load failed:", e);
  }

  loadDonorNearestCenters(donorLat, donorLon);
  donorDataLoaded = true;
}

function renderDonorHero(data) {
  // Hero blood type badge
  const bt = donorBloodType || "";
  setText("donor-hero-bt", bt);
  setText("donor-hero-bt-label", bt || "Your blood type");

  // Urgency of donor's specific type
  let urgencyLabel    = "needed now";
  let urgencyClass    = "";
  const btPriority    = (data.blood_type_priority || []).find(p => p.blood_type === bt);
  if (btPriority) {
    const ul = btPriority.urgency_label;
    if (ul === "CRITICAL") { urgencyLabel = "critically needed right now"; urgencyClass = ""; }
    else if (ul === "HIGH")     { urgencyLabel = "in high demand";         urgencyClass = "urgency-high"; }
    else if (ul === "MODERATE") { urgencyLabel = "moderately in demand";   urgencyClass = "urgency-moderate"; }
    else                        { urgencyLabel = "at stable levels";       urgencyClass = "urgency-stable"; }
  }

  const urgEl = el("donor-urgency-label");
  urgEl.textContent  = urgencyLabel;
  urgEl.className    = `donor-urgency-label ${urgencyClass}`;

  // Stat cards
  setText("donor-critical-count",  data.critical_count || 0);
  setText("donor-facilities-count", data.total_facilities_need || 0);
  setText("donor-most-needed-stat", data.most_needed_type || "O-");
  setText("donor-urgent-count",    (data.urgent_needs || []).length);
}

// Real-world blood type clinical context (source: American Red Cross, AABB)
const BT_CLINICAL = {
  "O-":  { pop: "7%",  universal: true,  note: "Universal donor — only type for emergency use when patient type unknown" },
  "O+":  { pop: "38%", universal: false, note: "Most transfused worldwide — highest total volume demand globally" },
  "A-":  { pop: "6%",  universal: false, note: "Rare negative — can donate to A+, A−, AB+, AB−" },
  "B-":  { pop: "2%",  universal: false, note: "Very rare — critical for B− and AB− patients only" },
  "A+":  { pop: "36%", universal: false, note: "Second most common — large patient population depends on this type" },
  "B+":  { pop: "8%",  universal: false, note: "Needed for B+ and AB+ recipients" },
  "AB-": { pop: "1%",  universal: false, note: "Rarest type — universal plasma donor; valuable for plasma donations" },
  "AB+": { pop: "3%",  universal: false, note: "Universal recipient — accepts all types; whole blood urgency is lowest" },
};

function renderDonorBloodTypePriority(priorities) {
  const grid = el("donor-bt-priority-grid");
  if (!priorities.length) {
    grid.innerHTML = '<div class="empty-state-sm">No data</div>';
    return;
  }

  grid.innerHTML = priorities.map((p, rank) => {
    const isMyType = donorBloodType && p.blood_type === donorBloodType;
    const barPct   = Math.min(100, Math.round((p.shortage_score / 2.0) * 100));
    const barColor = p.urgency_label === "CRITICAL" ? "var(--red)"
                   : p.urgency_label === "HIGH"     ? "var(--orange)"
                   : p.urgency_label === "MODERATE" ? "var(--amber)"
                   : "var(--green)";
    const ctx = BT_CLINICAL[p.blood_type] || {};

    return `
      <div class="donor-bt-card urgency-${p.urgency_label} ${isMyType ? "highlighted-bt" : ""}"
           title="${ctx.note || ""}">
        ${isMyType ? '<div class="bt-my-type-tag">Your Type</div>' : ""}
        ${ctx.universal ? '<div class="bt-universal-tag">Universal Donor</div>' : ""}
        <div class="donor-bt-rank">#${rank + 1}</div>
        <div class="donor-bt-type">${p.blood_type}</div>
        <div class="donor-bt-pop">${ctx.pop || ""} of population</div>
        <div class="supply-bar-track" style="margin:7px 0 5px">
          <div class="supply-bar-fill" style="width:${barPct}%;background:${barColor}"></div>
        </div>
        <div class="donor-bt-label ${p.urgency_label}">${p.urgency_label}</div>
        <div class="donor-bt-fac">${p.facilities_in_need} facilities</div>
        <div class="donor-bt-note">${(ctx.note || "").split(" — ")[0]}</div>
      </div>`;
  }).join("");
}

function renderDonorUrgentNeeds(urgentNeeds) {
  const list = el("donor-urgent-list");
  if (!urgentNeeds.length) {
    list.innerHTML = '<div class="empty-state-sm">No urgent needs detected</div>';
    return;
  }

  // Show top 8, prioritize donor's blood type
  const sorted = [...urgentNeeds].sort((a, b) => {
    const myA = a.blood_type === donorBloodType ? -1 : 0;
    const myB = b.blood_type === donorBloodType ? -1 : 0;
    if (myA !== myB) return myA - myB;
    const uo = { critical: 0, high: 1, moderate: 2 };
    return (uo[a.urgency] ?? 3) - (uo[b.urgency] ?? 3);
  }).slice(0, 8);

  list.innerHTML = sorted.map(n => {
    const isMyBT = donorBloodType && n.blood_type === donorBloodType;
    return `
      <div class="donor-urgent-card urg-${n.urgency} ${isMyBT ? "highlighted-bt" : ""}">
        <div class="donor-urgent-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span class="donor-urgent-bt">${n.blood_type}</span>
              ${isMyBT ? '<span class="badge badge-blue" style="font-size:9.5px">Your Type</span>' : ""}
            </div>
            <div class="donor-urgent-hospital">${n.hospital}</div>
            <div class="donor-urgent-city">${n.city}, ${n.state}</div>
          </div>
          <span class="donor-urgent-badge ${n.urgency}">${n.urgency.toUpperCase()}</span>
        </div>
        <div class="donor-urgent-why">${n.why_it_matters}</div>
        <div class="donor-urgent-stats">
          <span class="donor-urgent-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M20 7H4C2.9 7 2 7.9 2 9v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z" stroke="currentColor" stroke-width="1.8"/><path d="M16 3H8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            ${n.units_available} units left
          </span>
          <span class="donor-urgent-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            ${n.days_of_supply}d supply remaining
          </span>
          <span class="donor-urgent-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M3 3V21H21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 16L11 12L15 14L21 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            ${n.daily_usage}u/day demand
          </span>
        </div>
      </div>`;
  }).join("");
}

async function loadDonorNearestCenters(lat, lon) {
  try {
    const resp    = await fetch(`/api/donor/nearest-centers?lat=${lat}&lon=${lon}`);
    const centers = await resp.json();
    renderDonorNearestCenters(centers);
  } catch (e) {
    console.error("Nearest centers load failed:", e);
    el("donor-nearest-list").innerHTML = '<div class="empty-state-sm">Could not load centers</div>';
  }
}

function renderDonorNearestCenters(centers) {
  const list = el("donor-nearest-list");
  if (!centers.length) {
    list.innerHTML = '<div class="empty-state-sm">No centers found</div>';
    return;
  }

  list.innerHTML = centers.slice(0, 6).map((c, i) => {
    const rank       = i + 1;
    const isTopPick  = rank === 1;
    const critPills  = c.critical_blood_types.slice(0, 3).map(bt =>
      `<span class="donor-nearest-type-pill critical">${bt}</span>`).join("");
    const highPills  = c.high_need_types.slice(0, 2).map(bt =>
      `<span class="donor-nearest-type-pill high">${bt}</span>`).join("");
    const distMi     = (c.distance_km * 0.621).toFixed(1);

    return `
      <div class="donor-nearest-card ${isTopPick ? "top-pick" : ""}">
        <div class="donor-nearest-rank ${rank === 1 ? "rank-1" : ""}">${rank}</div>
        <div class="donor-nearest-info">
          <div class="donor-nearest-hospital">${c.hospital}</div>
          <div class="donor-nearest-location">${c.city}, ${c.state}</div>
          ${(critPills || highPills) ? `
          <div class="donor-nearest-types">
            ${critPills}${highPills}
          </div>` : ""}
          <div class="donor-nearest-why">${c.why_donate_here}</div>
        </div>
        <div class="donor-nearest-distance">
          ${distMi} mi<br>
          <span style="font-size:10px;color:var(--text-3);font-weight:400">${c.distance_km} km</span>
        </div>
      </div>`;
  }).join("");
}

function locateDonor() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      donorLat = pos.coords.latitude;
      donorLon = pos.coords.longitude;
      setText("donor-location-note", `Showing centers near your location`);
      loadDonorNearestCenters(donorLat, donorLon);
    },
    () => {
      alert("Could not get your location. Showing from New York City.");
    }
  );
}

function scrollToDonorNeeds() {
  el("donor-needs-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleDonateNow() {
  // Show a polished confirmation dialog (no real scheduling in hackathon)
  const hosp = donorData && donorData.urgent_needs && donorData.urgent_needs[0];
  if (hosp) {
    alert(`Connecting you to ${hosp.hospital} in ${hosp.city}, ${hosp.state}.\n\nIn a production system, this would open the facility's scheduling portal. Please call ahead to confirm appointment availability.`);
  } else {
    alert("Please visit your nearest blood center to schedule a donation appointment. Every pint counts.");
  }
}

// EXCHANGE NETWORK — MAP
function initExchangeTab() {
  if (mapInitialized) {
    // Map already up — just invalidate size for Leaflet layout refresh
    if (mapInstance) setTimeout(() => mapInstance.invalidateSize(), 120);
    return;
  }

  // Delay so the tab panel finishes rendering before Leaflet reads container size
  setTimeout(() => {
    if (window.GOOGLE_MAPS_KEY_SET && window.googleMapsReady) {
      initGoogleMapsMap();
    } else if (window.GOOGLE_MAPS_KEY_SET && typeof google !== "undefined" && google.maps) {
      initGoogleMapsMap();
    } else {
      initLeafletMap();
    }
  }, 80);
}

function initLeafletMap() {
  mapInstance = L.map("map", {
    center:      NE_CENTER_LEAFLET,
    zoom:        NE_ZOOM,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(mapInstance);

  mapInitialized = true;
  el("map-type-indicator").textContent = "Leaflet / OSM";
  loadHeatmap();
}

// Unified Google Maps API ready callback (exchange map only — home map uses Leaflet)
window.onGoogleMapsReady = function() {
  window.googleMapsReady = true;
  if (pendingHeatmap) {
    drawGoogleMarkers(heatmapData);
    pendingHeatmap = false;
  }
};

let homeMapInitialized = false;
function initHomeTab() {
  if (!homeMapInitialized) {
    initHomeMap();
  }
}

// Legacy callback kept for backward compat
window.initGoogleMap = function() {
  if (mapInitialized && mapInstance) return;
  initGoogleMapsMap();
};

// Home tab map — Leaflet with CartoDB dark tiles (no API key needed)
function initHomeMap() {
  const mapDiv = el("home-map");
  if (!mapDiv) return;
  if (mapDiv._initialized) return;
  mapDiv._initialized = true;
  homeMapInitialized  = true;

  const STATUS_COLOR = { stable: "#00ff88", warning: "#ffcc00", high_risk: "#ff6a1a", critical: "#ff0033" };

  const hMap = L.map(mapDiv, {
    center: [42.4, -72.0],
    zoom: 7,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 18,
  }).addTo(hMap);

  allHospitals.forEach(h => {
    const color  = STATUS_COLOR[h.status] || "#7a9cc0";
    const radius = 18000 + (h.avg_shortage_score || 0) * 20000;

    L.circle([h.latitude, h.longitude], {
      radius, color, fillColor: color, fillOpacity: 0.08,
      weight: 1, opacity: 0.3,
    }).addTo(hMap);

    const icon = L.divIcon({
      className: "",
      html: `<div style="width:13px;height:13px;background:${color};border:2px solid rgba(255,255,255,0.9);border-radius:50%;box-shadow:0 0 10px ${color}cc,0 0 4px rgba(0,0,0,0.8)"></div>`,
      iconSize: [13, 13], iconAnchor: [6, 6],
    });

    L.marker([h.latitude, h.longitude], { icon })
      .addTo(hMap)
      .bindPopup(`
        <div style="font-family:'Inter',sans-serif;padding:4px 2px">
          <div style="font-weight:700;font-size:13px;color:#fff;margin-bottom:2px">${h.name}</div>
          <div style="font-size:11px;color:#7a9ab8;margin-bottom:7px">${h.city}, ${h.state}</div>
          <div style="display:flex;justify-content:space-between;font-size:12px">
            <span style="color:${color};font-weight:700">${h.status.replace(/_/g," ").toUpperCase()}</span>
            <span style="color:#7a9ab8">${h.total_units.toLocaleString("en-US")} units</span>
          </div>
        </div>`, { maxWidth: 220 });
  });
}

function initGoogleMapsMap() {
  const mapDiv = el("map");
  if (!mapDiv || typeof google === "undefined") return;

  googleMap = new google.maps.Map(mapDiv, {
    center:    NE_CENTER_GOOGLE,
    zoom:      NE_ZOOM,
    styles:    GOOGLE_MAPS_DARK_STYLE,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
  });

  mapInitialized = true;
  el("map-type-indicator").textContent = "Google Maps";

  if (pendingHeatmap) {
    drawGoogleMarkers(heatmapData);
    pendingHeatmap = false;
  } else {
    loadHeatmap();
  }
}

// Make initGoogleMap globally accessible for the callback
window.initGoogleMap = initGoogleMap;

async function loadHeatmap() {
  try {
    const resp = await fetch("/api/heatmap");
    heatmapData = await resp.json();

    if (googleMap) {
      drawGoogleMarkers(heatmapData);
    } else if (mapInstance) {
      drawLeafletMarkers(heatmapData);
    } else {
      pendingHeatmap = true;
    }
  } catch (e) {
    console.error("Heatmap load failed:", e);
  }
}


//Leaflet marker rendering

function clearMapMarkers() {
  mapMarkers.forEach(m => { try { m.remove ? m.remove() : (m.setMap && m.setMap(null)); } catch (e) {} });
  mapOverlays.forEach(c => { try { c.remove ? c.remove() : (c.setMap && c.setMap(null)); } catch (e) {} });
  mapMarkers = [];
  mapOverlays = [];
  if (transferLine) {
    try { transferLine.remove ? transferLine.remove() : (transferLine.setMap && transferLine.setMap(null)); } catch (e) {}
    transferLine = null;
  }
}

function drawLeafletMarkers(data) {
  clearMapMarkers();
  data.forEach(h => {
    const color  = intensityToColor(h.stress_intensity);
    const radius = 15000 + h.stress_intensity * 25000;

    const circle = L.circle([h.lat, h.lon], {
      radius, color, fillColor: color, fillOpacity: 0.12, weight: 1.5, opacity: 0.5,
    }).addTo(mapInstance);
    mapOverlays.push(circle);

    const icon = L.divIcon({
      className: "",
      html: `<div style="width:13px;height:13px;background:${color};border:2px solid rgba(255,255,255,0.85);border-radius:50%;box-shadow:0 0 10px ${color}99;cursor:pointer"></div>`,
      iconSize: [13, 13], iconAnchor: [6, 6],
    });

    const marker = L.marker([h.lat, h.lon], { icon })
      .addTo(mapInstance)
      .bindPopup(buildMapPopupHTML(h), { maxWidth: 250 });

    marker.on("click", () => {
      loadHospitalDetailPanel(h.hospital);
      const tSel = el("transfer-hospital");
      if (tSel) tSel.value = h.hospital;
    });
    mapMarkers.push(marker);
  });
}


//Google Maps marker rendering 
function drawGoogleMarkers(data) {
  if (!googleMap) return;
  clearMapMarkers();

  data.forEach(h => {
    const color = intensityToColor(h.stress_intensity);

    const marker = new google.maps.Marker({
      position: { lat: h.lat, lng: h.lon },
      map:      googleMap,
      title:    h.hospital,
      icon: {
        path:        google.maps.SymbolPath.CIRCLE,
        fillColor:   color,
        fillOpacity: 0.92,
        strokeWeight: 2,
        strokeColor: "#ffffff",
        scale:        9 + h.stress_intensity * 6,
      },
    });

    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="background:#080808;padding:12px;border-radius:8px;min-width:200px">${buildMapPopupHTML(h)}</div>`,
    });

    marker.addListener("click", () => {
      infoWindow.open(googleMap, marker);
      loadHospitalDetailPanel(h.hospital);
      // Auto-populate transfer hospital selector when marker is clicked
      const tSel = el("transfer-hospital");
      if (tSel) tSel.value = h.hospital;
    });

    mapMarkers.push(marker);

    // Stress halo circle
    const circle = new google.maps.Circle({
      map:           googleMap,
      center:        { lat: h.lat, lng: h.lon },
      radius:        15000 + h.stress_intensity * 25000,
      fillColor:     color,
      fillOpacity:   0.08,
      strokeColor:   color,
      strokeOpacity: 0.4,
      strokeWeight:  1,
    });
    mapOverlays.push(circle);
  });
}

function buildMapPopupHTML(h) {
  const stressLabel = h.stress_intensity >= 0.7 ? "Critical"
    : h.stress_intensity >= 0.45 ? "High Risk"
    : h.stress_intensity >= 0.25 ? "Warning"
    : "Stable";
  const color = intensityToColor(h.stress_intensity);
  return `
    <div style="padding:4px 2px">
      <div style="font-weight:700;font-size:14px;color:#ffffff;margin-bottom:5px">${h.hospital}</div>
      <div style="font-size:12px;color:#c8daf0;margin-bottom:7px">${h.city}</div>
      <div style="font-size:12px;display:flex;gap:8px;align-items:center">
        <span style="color:${color};font-weight:700">${stressLabel}</span>
        <span style="color:#5a7a9e">·</span>
        <span style="color:#c8daf0">${h.total_units} units</span>
      </div>
      <div style="font-size:11px;color:#5a7a9e;margin-top:5px">
        ${h.critical_types} critical type(s) · ${h.near_expiry_batches} near-expiry batch(es)
      </div>
    </div>`;
}

async function loadHospitalDetailPanel(hospitalName) {
  try {
    const resp = await fetch(`/api/hospital/${encodeURIComponent(hospitalName)}`);
    const data = await resp.json();
    if (data.error) return;

    el("detail-hospital-name").textContent = `${data.name} — ${data.city}`;
    el("detail-inventory").innerHTML = data.inventory.map(item => `
      <div class="detail-inv-row">
        <span class="detail-bt">${item.blood_type}</span>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="detail-units">${item.total_units}u</span>
          <span style="font-size:11px;color:${STATUS_COLORS[item.status] || "#5a7a9e"};font-weight:700">${item.days_of_supply}d</span>
        </div>
      </div>`).join("");

    el("hospital-detail").classList.remove("hidden");
  } catch (e) {
    console.error("Hospital detail panel failed:", e);
  }
}

function closeHospitalDetail() {
  el("hospital-detail").classList.add("hidden");
}

async function filterMapByBloodType(bt, btn) {
  document.querySelectorAll(".bt-pill").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");

  if (bt === "ALL") {
    if (googleMap) drawGoogleMarkers(heatmapData);
    else drawLeafletMarkers(heatmapData);
    return;
  }

  try {
    const resp = await fetch(`/api/blood-types?type=${encodeURIComponent(bt)}`);
    const data = await resp.json();

    const statusMap = {};
    data.forEach(h => { statusMap[h.hospital] = h; });

    clearMapMarkers();

    heatmapData.forEach(h => {
      const info  = statusMap[h.hospital];
      const color = info ? (STATUS_COLORS[info.status] || "#7a9cc0") : "#2e4a6a";

      if (googleMap) {
        const marker = new google.maps.Marker({
          position: { lat: h.lat, lng: h.lon },
          map:      googleMap,
          title:    h.hospital,
          icon: {
            path:        google.maps.SymbolPath.CIRCLE,
            fillColor:   color,
            fillOpacity: 0.9,
            strokeWeight: 2,
            strokeColor: "#ffffff",
            scale:       10,
          },
        });
        const units   = info ? info.units : 0;
        const days    = info ? info.days_of_supply : 0;
        const iw      = new google.maps.InfoWindow({
          content: `<div style="background:#080808;padding:10px;border-radius:8px"><b style="color:#ffffff">${h.hospital}</b><br><span style="color:${color};font-weight:700">${bt}: ${units} units · ${days}d supply</span></div>`,
        });
        marker.addListener("click", () => { iw.open(googleMap, marker); loadHospitalDetailPanel(h.hospital); });
        mapMarkers.push(marker);
      } else {
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:13px;height:13px;background:${color};border:2px solid rgba(255,255,255,0.85);border-radius:50%;box-shadow:0 0 10px ${color}99;cursor:pointer"></div>`,
          iconSize: [13, 13], iconAnchor: [6, 6],
        });
        const units   = info ? info.units : 0;
        const days    = info ? info.days_of_supply : 0;
        const marker  = L.marker([h.lat, h.lon], { icon })
          .addTo(mapInstance)
          .bindPopup(`<div style="padding:4px 2px"><b style="color:#ffffff">${h.hospital}</b><br><span style="color:#c8daf0">${h.city}</span><br><span style="font-family:monospace;font-size:13px;color:#ffffff">${bt}</span><br><span style="color:${color};font-weight:700">${units} units · ${days}d supply</span></div>`, { maxWidth: 200 });
        marker.on("click", () => loadHospitalDetailPanel(h.hospital));
        mapMarkers.push(marker);
      }
    });
  } catch (e) {
    console.error("Blood type filter failed:", e);
  }
}


// TRANSFER RECOMMENDATION
async function runTransferRecommendation() {
  const hospital   = el("transfer-hospital").value;
  const blood_type = el("transfer-bt").value;

  if (!hospital || !blood_type) {
    alert("Please select both a hospital and blood type.");
    return;
  }

  try {
    const resp = await fetch("/api/transfer-recommendation", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ hospital, blood_type }),
    });
    const data = await resp.json();

    if (data.error) {
      el("transfer-best").innerHTML = `<p style="color:var(--text-3);padding:12px 0;font-size:13px">${data.error}</p>`;
      el("transfer-results").classList.remove("hidden");
      return;
    }

    renderTransferResults(data);

    // Draw route on map (Directions API for Google Maps, polyline for Leaflet)
    const reqHosp  = heatmapData.find(h => h.hospital === hospital);
    const bestHosp = data.closest || data.highest_stock;
    if (reqHosp && bestHosp) {
      const partnerH = heatmapData.find(h => h.hospital === bestHosp.hospital);
      if (partnerH) {
        if (googleMap && window.googleMapsReady) {
          // Clear previous renderer
          if (window._directionsRenderer) { window._directionsRenderer.setMap(null); }
          if (transferLine) { try { transferLine.setMap(null); } catch(e){} transferLine = null; }

          window._directionsRenderer = new google.maps.DirectionsRenderer({
            suppressMarkers: false,
            polylineOptions: { strokeColor: "#00d4ff", strokeWeight: 3, strokeOpacity: 0.88 },
          });
          window._directionsRenderer.setMap(googleMap);

          new google.maps.DirectionsService().route({
            origin:      { lat: reqHosp.lat,  lng: reqHosp.lon  },
            destination: { lat: partnerH.lat, lng: partnerH.lon },
            travelMode:  google.maps.TravelMode.DRIVING,
          }, (result, status) => {
            if (status === "OK") {
              window._directionsRenderer.setDirections(result);
              const leg    = result.routes[0].legs[0];
              const drInfo = el("transfer-drive-info");
              if (drInfo) drInfo.textContent = `${leg.duration.text} · ${leg.distance.text} by road`;
            } else {
              // Fallback straight line if Directions fails
              window._directionsRenderer.setMap(null);
              transferLine = new google.maps.Polyline({
                path: [{ lat: reqHosp.lat, lng: reqHosp.lon }, { lat: partnerH.lat, lng: partnerH.lon }],
                geodesic: true, strokeColor: "#00d4ff", strokeOpacity: 0.8, strokeWeight: 2.5,
                map: googleMap,
              });
            }
            const bounds = new google.maps.LatLngBounds();
            bounds.extend({ lat: reqHosp.lat, lng: reqHosp.lon });
            bounds.extend({ lat: partnerH.lat, lng: partnerH.lon });
            googleMap.fitBounds(bounds, 80);
          });
        } else if (googleMap) {
          // Google Maps but Directions not ready yet — straight line fallback
          if (transferLine) { try { transferLine.setMap(null); } catch(e){} }
          transferLine = new google.maps.Polyline({
            path: [{ lat: reqHosp.lat, lng: reqHosp.lon }, { lat: partnerH.lat, lng: partnerH.lon }],
            geodesic: true, strokeColor: "#00d4ff", strokeOpacity: 0.8, strokeWeight: 2.5,
            map: googleMap,
          });
          const bounds = new google.maps.LatLngBounds();
          bounds.extend({ lat: reqHosp.lat, lng: reqHosp.lon });
          bounds.extend({ lat: partnerH.lat, lng: partnerH.lon });
          googleMap.fitBounds(bounds, 60);
        } else {
          if (transferLine) transferLine.remove();
          transferLine = L.polyline(
            [[reqHosp.lat, reqHosp.lon], [partnerH.lat, partnerH.lon]],
            { color: "#00d4ff", weight: 2.5, dashArray: "6 4", opacity: 0.85 }
          ).addTo(mapInstance);
          mapInstance.fitBounds(transferLine.getBounds(), { padding: [40, 40] });
        }
      }
    }
  } catch (e) {
    console.error("Transfer recommendation failed:", e);
  }
}

function renderTransferResults(data) {
  const { closest, highest_stock, candidates } = data;
  let bestHTML = "";

  if (closest) {
    bestHTML += `
      <div class="transfer-card best">
        <div class="transfer-card-label">Best Overall — Closest</div>
        <div class="transfer-hospital-name">${closest.hospital}</div>
        <div class="transfer-stats">
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Location</span>
            <span class="transfer-stat-val">${closest.city}, ${closest.state}</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Distance</span>
            <span class="transfer-stat-val">${kmToMi(closest.distance_km)} mi</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Est. transport</span>
            <span class="transfer-stat-val">${fmtTransport(closest.estimated_transfer_hours)} ground</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">${data.blood_type} available</span>
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
            <span class="transfer-stat-val">${kmToMi(highest_stock.distance_km)} mi</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Est. transport</span>
            <span class="transfer-stat-val">${fmtTransport(highest_stock.estimated_transfer_hours)}</span>
          </div>
          <div class="transfer-stat-row">
            <span class="transfer-stat-key">Available</span>
            <span class="transfer-stat-val good">${highest_stock.total_units} units</span>
          </div>
        </div>
      </div>`;
  }

  el("transfer-best").innerHTML = bestHTML;

  if (candidates && candidates.length > 2) {
    let html = `<div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.7px;font-weight:700;margin:10px 0 6px">All Candidates</div>`;
    candidates.slice(0, 6).forEach(c => {
      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">
          <div>
            <div style="color:var(--text-1);font-weight:600">${c.hospital}</div>
            <div style="color:var(--text-3);font-size:11px">${kmToMi(c.distance_km)} mi · ${fmtTransport(c.estimated_transfer_hours)}</div>
          </div>
          <span style="color:var(--green);font-weight:700;font-size:13px;font-family:monospace">${c.total_units}u</span>
        </div>`;
    });
    el("transfer-all").innerHTML = html;
  } else {
    el("transfer-all").innerHTML = "";
  }

  el("transfer-results").classList.remove("hidden");
}



// AI PREDICTIONS
let allPredictions  = [];
let predLoadAttempt = 0;

async function loadPredictions() {
  // Allow re-load by clearing the cache if first load had no predictions
  if (allPredictions.length > 0 && predLoadAttempt > 0) {
    // Already loaded — just re-render the filter
    renderPredictionList("all");
    return;
  }
  predLoadAttempt++;

  el("predictions-list").innerHTML = '<div class="empty-state"><p>Loading AI predictions...</p></div>';

  try {
    const resp = await fetch("/api/predictions");
    const data = await resp.json();

    allPredictions = data.predictions || [];

    setText("risk-stable",    data.summary.stable);
    setText("risk-watchlist", data.summary.watchlist);
    setText("risk-high",      data.summary.high_risk);
    setText("risk-critical",  data.summary.critical);

    // Reset filter
    document.querySelectorAll(".pred-filter").forEach(b => {
      b.classList.toggle("active", b.dataset.filter === "all");
    });

    renderPredictionList("all");
  } catch (e) {
    console.error("Predictions load failed:", e);
    el("predictions-list").innerHTML = '<div class="empty-state"><p>Failed to load predictions. Check backend.</p></div>';
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

  const RISK_LABEL = { 3: "Critical", 2: "High Risk", 1: "Watchlist", 0: "Stable" };

  el("predictions-list").innerHTML = items.map(p => {
    const color = RISK_COLORS[p.risk_level];
    const label = RISK_LABEL[p.risk_level];
    const confidence = Math.round((p.confidence || 0) * 100);
    const city = p.city ? `${p.city}, ${p.state}` : "";
    return `
      <div class="pred-card" data-risk="${p.risk_level}">
        <div class="pred-bt-badge" style="color:${color}">${p.blood_type}</div>
        <div class="pred-main">
          <div class="pred-hospital">${p.hospital}</div>
          ${city ? `<div class="pred-location">${city}</div>` : ""}
          <div class="pred-explanation">${p.explanation}</div>
        </div>
        <div class="pred-meta">
          <span class="pred-risk-tag" style="color:${color};border-color:${color}">${label}</span>
          <div class="pred-stats">${p.days_of_supply}d supply · ${confidence}% confidence</div>
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
      labels:   ["Stable", "Watchlist", "High Risk", "Critical"],
      datasets: [{
        data:            [summary.stable, summary.watchlist, summary.high_risk, summary.critical],
        backgroundColor: ["rgba(0,230,118,0.2)", "rgba(255,171,64,0.2)", "rgba(255,112,67,0.2)", "rgba(255,23,68,0.2)"],
        borderColor:     ["#00e676",             "#ffab40",              "#ff7043",              "#ff1744"],
        borderWidth: 2,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#c8daf0", font: { size: 11, family: "Inter" }, padding: 14, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: "#080808", borderColor: "#2a2a2a", borderWidth: 1,
          titleColor: "#ffffff", bodyColor: "#c8daf0",
        },
      },
    },
  });
}

function renderFeatureImportance(features) {
  const list = el("feature-importance-list");
  if (!features.length) { list.innerHTML = ""; return; }

  const top    = features.slice(0, 7);
  const maxImp = top[0]?.importance || 1;

  const FRIENDLY = {
    shortage_score_7d:      "7-Day Shortage Score",
    days_of_supply:         "Days of Supply",
    units_available:        "Units Available",
    near_expiry_fraction:   "Near-Expiry Fraction",
    daily_usage:            "Daily Usage Rate",
    trauma_rate:            "Trauma Rate",
    surgery_schedule_score: "Surgery Schedule",
    demand_pressure:        "Demand Pressure",
    days_until_expiry:      "Days Until Expiry",
    historical_demand:      "Historical Demand",
    season_enc:             "Seasonality",
  };

  list.innerHTML = top.map(f => {
    const pct  = Math.round((f.importance / maxImp) * 100);
    const name = FRIENDLY[f.feature] || f.feature;
    return `
      <div class="fi-item">
        <div class="fi-label">${name}<span>${(f.importance * 100).toFixed(1)}%</span></div>
        <div class="fi-track"><div class="fi-fill" style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

// ANALYTICS
async function loadAnalytics() {
  // Always re-load analytics on tab visit (destroy old charts first)
  destroyChart("inventory");
  destroyChart("demandTrend");

  try {
    const resp = await fetch("/api/analytics");
    const data = await resp.json();

    setText("an-total-inv",   fmt(data.total_inventory));
    setText("an-expiry-risk", fmt(data.units_at_expiry_risk));
    setText("an-stressed",    fmt(data.hospitals_under_stress));
    setText("an-coverage",    data.inventory_days_coverage + "d");

    buildInventoryChart(data);
    buildDemandTrendChart(data);
  } catch (e) {
    console.error("Analytics load failed:", e);
  }
}

function buildInventoryChart(data) {
  const ctx = el("inventory-chart");
  if (!ctx) return;

  const types  = Object.keys(data.blood_type_inventory).sort();
  const stocks = types.map(t => data.blood_type_inventory[t] || 0);
  const usages = types.map(t => Math.round((data.blood_type_daily_usage[t] || 0) * 7));

  charts["inventory"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: types,
      datasets: [
        {
          label: "Units in Stock",
          data:  stocks,
          backgroundColor: "rgba(0,212,255,0.18)",
          borderColor:     "#00d4ff",
          borderWidth: 1.5, borderRadius: 5,
        },
        {
          label: "7-Day Demand",
          data:  usages,
          backgroundColor: "rgba(255,23,68,0.18)",
          borderColor:     "#ff1744",
          borderWidth: 1.5, borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:  { labels: { color: "#c8daf0", font: { size: 11, family: "Inter" } } },
        tooltip: { backgroundColor: "#080808", borderColor: "#2a2a2a", borderWidth: 1, titleColor: "#ffffff", bodyColor: "#c8daf0" },
      },
      scales: {
        x: { grid: { color: "#2a2a2a40" }, ticks: { color: "#5a7a9e", font: { family: "JetBrains Mono", size: 11 } } },
        y: { grid: { color: "#2a2a2a40" }, ticks: { color: "#5a7a9e", font: { size: 11 } } },
      },
    },
  });
}

function buildDemandTrendChart(data) {
  const ctx = el("demand-trend-chart");
  if (!ctx) return;

  const weeks  = ["Wk −7", "Wk −6", "Wk −5", "Wk −4", "Wk −3", "Wk −2", "Last Wk", "Current"];
  const colors = { "O+": "#ff5252", "O-": "#ff1744", "A+": "#00d4ff", "B+": "#7c3aed" };

  const datasets = Object.entries(data.weekly_demand_trends || {}).map(([bt, vals]) => ({
    label:           bt,
    data:            vals,
    borderColor:     colors[bt] || "#7a9cc0",
    backgroundColor: (colors[bt] || "#7a9cc0") + "14",
    fill:       true, tension: 0.4,
    borderWidth: 2, pointRadius: 3, pointHoverRadius: 6,
  }));

  charts["demandTrend"] = new Chart(ctx, {
    type: "line",
    data: { labels: weeks, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:  { labels: { color: "#c8daf0", font: { size: 11, family: "Inter" } } },
        tooltip: {
          backgroundColor: "#080808", borderColor: "#2a2a2a", borderWidth: 1,
          titleColor: "#ffffff", bodyColor: "#c8daf0",
          mode: "index", intersect: false,
        },
      },
      scales: {
        x: { grid: { color: "#2a2a2a40" }, ticks: { color: "#5a7a9e", font: { size: 11 } } },
        y: { grid: { color: "#2a2a2a40" }, ticks: { color: "#5a7a9e", font: { size: 11 } } },
      },
    },
  });
}

function buildStressTable(hospitals) {
  const container = el("hospital-stress-table");
  if (!container) return;

  const maxScore = Math.max(...hospitals.map(h => h.avg_shortage_score), 0.01);

  let html = `
    <div class="stress-row header">
      <span>Hospital</span>
      <span>Units</span>
      <span>Near Expiry</span>
      <span>Shortage Score</span>
      <span>Status</span>
    </div>`;

  html += hospitals.slice(0, 20).map(h => {
    const barW  = Math.round((h.avg_shortage_score / maxScore) * 100);
    const color = h.stress_level === "critical" ? "#ff1744"
                : h.stress_level === "warning"  ? "#ffab40"
                : "#00e676";
    return `
      <div class="stress-row">
        <div>
          <div class="stress-hospital">${h.hospital}</div>
          <div class="stress-city">${h.city}, ${h.state}</div>
        </div>
        <span class="stress-val">${fmt(h.total_units)}</span>
        <span class="stress-val" style="color:${h.near_expiry_units > 0 ? "var(--amber)" : "var(--text-3)"}">
          ${h.near_expiry_units}
        </span>
        <div>
          <div style="font-size:12px;color:${color};font-weight:700;margin-bottom:4px">${h.avg_shortage_score.toFixed(3)}</div>
          <div class="stress-bar-track">
            <div class="stress-bar-fill" style="width:${barW}%;background:${color}"></div>
          </div>
        </div>
        <span class="status-pill ${h.stress_level}">${h.stress_level}</span>
      </div>`;
  }).join("");

  container.innerHTML = html;
}
