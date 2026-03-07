"""
app.py
------
bloodBridge Flask backend.
Loads (or regenerates) dataset.csv, trains the shortage predictor,
and exposes REST API endpoints consumed by the single-page frontend.
"""

import os
import random as _random
from datetime import datetime
from flask import Flask, jsonify, request, render_template, session, redirect
import pandas as pd

from data_generator import generate_dataset
from algorithms import (
    get_expiry_warnings,
    get_low_inventory_warnings,
    get_hospital_summary,
    find_transfer_partners,
    get_heatmap_data,
    get_blood_type_availability,
    shortage_score,
    days_until_expiry,
    haversine_km,
)
from ml_model import train_model, get_predictions, get_feature_importance

# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = "bloodbridge-greyhacks26-secret"
DATASET_PATH = "dataset.csv"

# Google Maps API key — set via environment variable GOOGLE_MAPS_API_KEY
# Once provided, the frontend automatically switches from Leaflet to Google Maps.
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")


# ---------------------------------------------------------------------------
# Startup: load data + train model
# ---------------------------------------------------------------------------

def load_data() -> pd.DataFrame:
    """
    Load dataset.csv if it has ≥30 Northeast hospitals, otherwise regenerate.
    This ensures stale Midwest data is automatically replaced on first run.
    """
    need_regen = True
    if os.path.exists(DATASET_PATH):
        try:
            df = pd.read_csv(DATASET_PATH)
            if df["hospital_name"].nunique() >= 70:
                need_regen = False
        except Exception:
            need_regen = True

    if need_regen:
        print("[bloodBridge] Generating Northeast dataset...")
        df = generate_dataset()
        df.to_csv(DATASET_PATH, index=False)
    else:
        df = pd.read_csv(DATASET_PATH)

    return df


df = load_data()
train_model(df)
print(f"[bloodBridge] Ready — {len(df)} records, {df['hospital_name'].nunique()} hospitals.")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def login():
    data     = request.get_json() or {}
    name     = data.get("name", "").strip()
    role     = data.get("role", "").strip()
    hospital = data.get("hospital", "").strip()
    donor_bt = data.get("donor_blood_type", "").strip()
    if not name or not role:
        return jsonify({"error": "Name and role are required"}), 400
    user = {"name": name, "role": role, "hospital": hospital, "donor_blood_type": donor_bt}
    session["user"] = user
    return jsonify({"success": True, "user": user})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("user", None)
    return jsonify({"success": True})


@app.route("/api/register", methods=["POST"])
def register():
    data     = request.get_json() or {}
    name     = data.get("name", "").strip()
    email    = data.get("email", "").strip()
    role     = data.get("role", "").strip()
    hospital = data.get("hospital", "").strip()
    donor_bt = data.get("donor_blood_type", "").strip()
    if not name or not role:
        return jsonify({"error": "Name and role are required"}), 400
    user = {"name": name, "email": email, "role": role, "hospital": hospital, "donor_blood_type": donor_bt}
    session["user"] = user
    return jsonify({"success": True, "user": user})


# ---------------------------------------------------------------------------
# Overview / system-wide stats
# ---------------------------------------------------------------------------

@app.route("/api/overview")
def overview():
    total_units     = int(df["units_available"].sum())
    total_hospitals = int(df["hospital_name"].nunique())

    near_expiry_units = 0
    for _, row in df.iterrows():
        d = days_until_expiry(str(row["expiration_date"]))
        if 0 <= d <= 7:
            near_expiry_units += int(row["units_available"])

    # Critical blood-type situations (aggregated per hospital+bt)
    critical_count = 0
    for (hospital, bt), grp in df.groupby(["hospital_name", "blood_type"]):
        s = shortage_score(float(grp["daily_usage"].mean()), int(grp["units_available"].sum()))
        if s >= 1.5:
            critical_count += 1

    # Transfer opportunities
    transfer_opps = 0
    for bt in df["blood_type"].unique():
        bt_df = df[df["blood_type"] == bt]
        has_surplus  = (bt_df["units_available"] > 25).any()
        has_stressed = (bt_df["shortage_risk_score"] > 1.0).any()
        if has_surplus and has_stressed:
            transfer_opps += 1

    expiry_warnings = get_expiry_warnings(df)
    low_inv         = get_low_inventory_warnings(df)

    return jsonify({
        "total_units":              total_units,
        "total_hospitals":          total_hospitals,
        "near_expiry_units":        near_expiry_units,
        "critical_inventory_count": critical_count,
        "transfer_opportunities":   transfer_opps,
        "expiry_warnings":          expiry_warnings[:10],
        "low_inventory_warnings":   low_inv[:10],
        "last_updated":             datetime.now().strftime("%b %d, %Y %H:%M"),
    })


# ---------------------------------------------------------------------------
# Hospital list
# ---------------------------------------------------------------------------

@app.route("/api/hospitals")
def get_hospitals():
    agg = df.groupby("hospital_name").agg(
        city=("city",                 "first"),
        state=("state",               "first"),
        latitude=("latitude",         "first"),
        longitude=("longitude",       "first"),
        total_units=("units_available", "sum"),
        avg_shortage=("shortage_risk_score", "mean"),
    ).reset_index()

    result = []
    for _, row in agg.iterrows():
        avg_s = float(row["avg_shortage"])
        result.append({
            "name":               row["hospital_name"],
            "city":               row["city"],
            "state":              row["state"],
            "latitude":           float(row["latitude"]),
            "longitude":          float(row["longitude"]),
            "total_units":        int(row["total_units"]),
            "avg_shortage_score": round(avg_s, 3),
            "status": (
                "critical"  if avg_s >= 1.5 else
                "high_risk" if avg_s >= 0.8 else
                "warning"   if avg_s >= 0.4 else
                "stable"
            ),
        })
    return jsonify(result)


# ---------------------------------------------------------------------------
# Single hospital inventory
# ---------------------------------------------------------------------------

@app.route("/api/hospital/<path:hospital_name>")
def get_hospital(hospital_name):
    inventory = get_hospital_summary(df, hospital_name)
    if not inventory:
        return jsonify({"error": "Hospital not found"}), 404
    row = df[df["hospital_name"] == hospital_name].iloc[0]
    return jsonify({
        "name":      hospital_name,
        "city":      str(row["city"]),
        "state":     str(row["state"]),
        "latitude":  float(row["latitude"]),
        "longitude": float(row["longitude"]),
        "inventory": inventory,
    })


# ---------------------------------------------------------------------------
# Blood type availability
# ---------------------------------------------------------------------------

@app.route("/api/blood-types")
def blood_types():
    bt_filter = request.args.get("type")
    if bt_filter:
        return jsonify(get_blood_type_availability(df, bt_filter))
    totals = df.groupby("blood_type")["units_available"].sum().to_dict()
    usage  = df.groupby("blood_type")["daily_usage"].sum().round(1).to_dict()
    return jsonify({
        "totals":      {k: int(v)   for k, v in totals.items()},
        "daily_usage": {k: float(v) for k, v in usage.items()},
    })


# ---------------------------------------------------------------------------
# Heatmap
# ---------------------------------------------------------------------------

@app.route("/api/heatmap")
def heatmap():
    return jsonify(get_heatmap_data(df))


# ---------------------------------------------------------------------------
# Transfer recommendation
# ---------------------------------------------------------------------------

@app.route("/api/transfer-recommendation", methods=["POST"])
def transfer_recommendation():
    data       = request.get_json() or {}
    hospital   = data.get("hospital")
    blood_type = data.get("blood_type")
    if not hospital or not blood_type:
        return jsonify({"error": "hospital and blood_type are required"}), 400
    return jsonify(find_transfer_partners(df, hospital, blood_type))


# ---------------------------------------------------------------------------
# AI shortage predictions
# ---------------------------------------------------------------------------

@app.route("/api/predictions")
def predictions():
    preds    = get_predictions(df)
    by_level = {0: [], 1: [], 2: [], 3: []}
    for p in preds:
        by_level[p["risk_level"]].append(p)

    return jsonify({
        "predictions": preds,
        "summary": {
            "stable":    len(by_level[0]),
            "watchlist": len(by_level[1]),
            "high_risk": len(by_level[2]),
            "critical":  len(by_level[3]),
        },
        "feature_importance": get_feature_importance(),
        "top_critical":  by_level[3][:8],
        "top_high_risk": by_level[2][:8],
    })


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@app.route("/api/analytics")
def analytics():
    bt_inventory = df.groupby("blood_type")["units_available"].sum().to_dict()
    bt_usage     = df.groupby("blood_type")["daily_usage"].sum().round(1).to_dict()

    near_exp_by_hosp: dict = {}
    for _, row in df.iterrows():
        d = days_until_expiry(str(row["expiration_date"]))
        if 0 <= d <= 7:
            h = row["hospital_name"]
            near_exp_by_hosp[h] = near_exp_by_hosp.get(h, 0) + int(row["units_available"])

    units_at_risk = sum(near_exp_by_hosp.values())

    hospital_stress = []
    for hospital in df["hospital_name"].unique():
        h_df  = df[df["hospital_name"] == hospital]
        avg_s = float(h_df["shortage_risk_score"].mean())
        hospital_stress.append({
            "hospital":           hospital,
            "city":               h_df.iloc[0]["city"],
            "state":              h_df.iloc[0]["state"],
            "total_units":        int(h_df["units_available"].sum()),
            "avg_shortage_score": round(avg_s, 3),
            "near_expiry_units":  near_exp_by_hosp.get(hospital, 0),
            "stress_level": (
                "critical" if avg_s >= 1.5 else
                "warning"  if avg_s >= 0.6 else
                "stable"
            ),
        })
    hospital_stress.sort(key=lambda x: x["avg_shortage_score"], reverse=True)

    # 8-week demand trend anchored to actual daily usage
    weekly_demand: dict = {}
    for bt in ["O+", "O-", "A+", "B+"]:
        base = float(df[df["blood_type"] == bt]["daily_usage"].sum()) * 7
        weekly_demand[bt] = [
            round(base * (0.82 + i * 0.025 + (i % 3) * 0.018 + (0.05 if i in [3, 6] else 0)), 1)
            for i in range(8)
        ]

    season_risk = df.groupby("season")["shortage_risk_score"].mean().round(3).to_dict()

    total_daily  = float(df["daily_usage"].sum())
    total_inv    = int(df["units_available"].sum())

    return jsonify({
        "blood_type_inventory":    {k: int(v)   for k, v in bt_inventory.items()},
        "blood_type_daily_usage":  {k: float(v) for k, v in bt_usage.items()},
        "units_at_expiry_risk":    units_at_risk,
        "hospitals_under_stress":  len([h for h in hospital_stress if h["stress_level"] != "stable"]),
        "hospital_stress":         hospital_stress,
        "weekly_demand_trends":    weekly_demand,
        "season_shortage_risk":    season_risk,
        "total_daily_demand":      round(total_daily, 1),
        "total_inventory":         total_inv,
        "inventory_days_coverage": round(total_inv / max(total_daily, 0.1), 1),
        "near_expiry_by_hospital": near_exp_by_hosp,
        "estimated_waste_units":   int(units_at_risk * 0.35),   # ~35% near-expiry won't be used
        "top_stressed":            hospital_stress[:5],
    })


# ---------------------------------------------------------------------------
# Donor API endpoints
# ---------------------------------------------------------------------------

def _donor_why_it_matters(blood_type: str, urgency: str,
                           days_supply: float, hospital: str) -> str:
    hosp_short = hospital.split()[0]
    messages = {
        "critical": [
            f"{blood_type} is critically low at {hosp_short} — only {days_supply:.1f} day(s) of supply remain.",
            f"Emergency surgeries at {hosp_short} are at risk. {blood_type} stock could be exhausted within hours.",
            f"{hosp_short} has flagged {blood_type} as an immediate critical need. Trauma cases depend on this supply.",
        ],
        "high": [
            f"{blood_type} stock at {hosp_short} is running dangerously low ({days_supply:.1f}d supply remaining).",
            f"Demand is outpacing supply for {blood_type} at {hosp_short}. A donation now prevents a shortage.",
        ],
        "moderate": [
            f"{blood_type} levels at {hosp_short} are below recommended safe thresholds.",
            f"{hosp_short} is requesting {blood_type} donors to bolster reserves before the next demand surge.",
        ],
    }
    _random.seed(hash(hospital + blood_type) % 9999)
    return _random.choice(messages.get(urgency, messages["moderate"]))


def _why_donate_here(hospital: str, critical: list, high: list, dist: float) -> str:
    if critical:
        types = ", ".join(critical[:3])
        return f"CRITICAL need for {types}. Your donation goes directly to emergency use."
    elif high:
        types = ", ".join(high[:3])
        return f"High demand for {types}. Stock is running low — donations are urgently needed."
    return f"Accepting all blood types to maintain regional reserves."


@app.route("/api/donor/urgent-needs")
def donor_urgent_needs():
    """
    Returns urgent blood donation needs across the Northeast network.
    Used by the Donor Dashboard.
    """
    urgent = []
    for (hospital, bt), grp in df.groupby(["hospital_name", "blood_type"]):
        total_units = int(grp["units_available"].sum())
        avg_daily   = float(grp["daily_usage"].mean())
        days_supply = round(total_units / max(avg_daily, 0.1), 1)
        s_score     = shortage_score(avg_daily, total_units)

        if s_score >= 0.6 or days_supply < 10:
            row = grp.iloc[0]
            urgency = (
                "critical" if s_score >= 1.5 or days_supply < 2 else
                "high"     if s_score >= 0.8 or days_supply < 5  else
                "moderate"
            )
            urgent.append({
                "hospital":        hospital,
                "city":            str(row["city"]),
                "state":           str(row["state"]),
                "lat":             float(row["latitude"]),
                "lon":             float(row["longitude"]),
                "blood_type":      bt,
                "units_available": total_units,
                "daily_usage":     round(avg_daily, 1),
                "days_of_supply":  days_supply,
                "shortage_score":  round(s_score, 3),
                "urgency":         urgency,
                "why_it_matters":  _donor_why_it_matters(bt, urgency, days_supply, hospital),
            })

    urgent.sort(key=lambda x: (
        {"critical": 0, "high": 1, "moderate": 2}[x["urgency"]],
        -x["shortage_score"]
    ))

    # Network-wide blood type priority
    bt_priority = []
    for bt in df["blood_type"].unique():
        bt_df       = df[df["blood_type"] == bt]
        total_units = int(bt_df["units_available"].sum())
        total_daily = float(bt_df["daily_usage"].sum())
        s           = round((total_daily * 7) / max(total_units, 1), 3)
        fac_in_need = sum(
            1 for (h, btype), g in df[df["blood_type"] == bt].groupby(["hospital_name", "blood_type"])
            if (float(g["daily_usage"].mean()) * 7) / max(int(g["units_available"].sum()), 1) >= 0.8
        )
        # Clinical minimum urgency by blood type (based on real-world demand/rarity)
        CLINICAL_MIN = {"O-": "CRITICAL", "O+": "HIGH", "B-": "HIGH", "A-": "HIGH"}
        data_urgency = (
            "CRITICAL" if s >= 1.2 else
            "HIGH"     if s >= 0.55 else
            "MODERATE" if s >= 0.28 else
            "STABLE"
        )
        urgency_rank = {"STABLE": 0, "MODERATE": 1, "HIGH": 2, "CRITICAL": 3}
        clinical_min = CLINICAL_MIN.get(bt, "STABLE")
        urgency_label = (
            data_urgency if urgency_rank[data_urgency] >= urgency_rank[clinical_min]
            else clinical_min
        )
        bt_priority.append({
            "blood_type":         bt,
            "total_units":        total_units,
            "daily_demand":       round(total_daily, 1),
            "shortage_score":     s,
            "facilities_in_need": fac_in_need,
            "urgency_label":      urgency_label,
        })
    bt_priority.sort(key=lambda x: x["shortage_score"], reverse=True)

    critical_count = len([u for u in urgent if u["urgency"] == "critical"])

    return jsonify({
        "urgent_needs":           urgent[:20],
        "blood_type_priority":    bt_priority,
        "critical_count":         critical_count,
        "total_facilities_need":  len(set(u["hospital"] for u in urgent)),
        "most_needed_type":       bt_priority[0]["blood_type"] if bt_priority else "O-",
    })


@app.route("/api/donor/nearest-centers")
def donor_nearest_centers():
    """
    Return facilities sorted by proximity to the donor's location.
    Falls back to NYC (40.7128, -74.0060) if no coords provided.
    """
    try:
        user_lat = float(request.args.get("lat", 40.7128))
        user_lon = float(request.args.get("lon", -74.0060))
    except (ValueError, TypeError):
        user_lat, user_lon = 40.7128, -74.0060

    results = []
    for hospital in df["hospital_name"].unique():
        h_df = df[df["hospital_name"] == hospital]
        lat  = float(h_df.iloc[0]["latitude"])
        lon  = float(h_df.iloc[0]["longitude"])
        dist = haversine_km(user_lat, user_lon, lat, lon)

        critical_types, high_types = [], []
        for bt in h_df["blood_type"].unique():
            bt_rows = h_df[h_df["blood_type"] == bt]
            total   = int(bt_rows["units_available"].sum())
            daily   = float(bt_rows["daily_usage"].mean())
            s       = shortage_score(daily, total)
            if s >= 1.5:
                critical_types.append(bt)
            elif s >= 0.8:
                high_types.append(bt)

        avg_s  = float(h_df["shortage_risk_score"].mean())
        urgency = (
            "critical" if avg_s >= 1.5 else
            "high"     if avg_s >= 0.8 else
            "moderate" if avg_s >= 0.4 else
            "stable"
        )

        results.append({
            "hospital":             hospital,
            "city":                 str(h_df.iloc[0]["city"]),
            "state":                str(h_df.iloc[0]["state"]),
            "lat":                  lat,
            "lon":                  lon,
            "distance_km":          round(dist, 1),
            "critical_blood_types": critical_types,
            "high_need_types":      high_types,
            "avg_shortage_score":   round(avg_s, 3),
            "urgency":              urgency,
            "total_units":          int(h_df["units_available"].sum()),
            "why_donate_here":      _why_donate_here(hospital, critical_types, high_types, dist),
        })

    results.sort(key=lambda x: x["distance_km"])
    return jsonify(results[:18])


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    user = session.get("user")
    return render_template("index.html",
                           google_maps_key=GOOGLE_MAPS_API_KEY,
                           session_user=user)


@app.route("/app")
def app_redirect():
    return redirect("/")


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8080)
