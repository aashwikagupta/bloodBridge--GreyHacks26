"""
app.py
------
BloodBridge Flask backend.
Loads (or generates) dataset.csv, trains the shortage predictor,
and exposes clean REST API endpoints consumed by the single-page frontend.
"""

import os
from datetime import datetime
from flask import Flask, jsonify, request, render_template, session
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
)
from ml_model import train_model, get_predictions, get_feature_importance

# ---------------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = "bloodbridge-greyhacks26-secret"
DATASET_PATH = "dataset.csv"


# ---------------------------------------------------------------------------
# Startup: load data + train model
# ---------------------------------------------------------------------------

def load_data() -> pd.DataFrame:
    if not os.path.exists(DATASET_PATH):
        print("[BloodBridge] dataset.csv not found — generating fresh data...")
        df = generate_dataset()
        df.to_csv(DATASET_PATH, index=False)
    else:
        df = pd.read_csv(DATASET_PATH)
    return df


df = load_data()
train_model(df)
print(f"[BloodBridge] Ready — {len(df)} records, {df['hospital_name'].nunique()} hospitals.")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    role = data.get("role", "").strip()
    if not name or not role:
        return jsonify({"error": "Name and role are required"}), 400
    session["user"] = {"name": name, "role": role}
    return jsonify({"success": True, "user": {"name": name, "role": role}})


# ---------------------------------------------------------------------------
# Overview / system-wide stats
# ---------------------------------------------------------------------------

@app.route("/api/overview")
def overview():
    total_units      = int(df["units_available"].sum())
    total_hospitals  = int(df["hospital_name"].nunique())

    near_expiry_units = 0
    for _, row in df.iterrows():
        d = days_until_expiry(str(row["expiration_date"]))
        if 0 <= d <= 7:
            near_expiry_units += int(row["units_available"])

    # Count critical blood-type situations per hospital (aggregate batches first)
    critical_count = 0
    for (hospital, bt), grp in df.groupby(["hospital_name", "blood_type"]):
        s = shortage_score(float(grp["daily_usage"].mean()), int(grp["units_available"].sum()))
        if s >= 1.5:
            critical_count += 1

    # Transfer opportunities: blood types where at least one hospital has surplus
    # and at least one hospital is under stress
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
        "total_units":             total_units,
        "total_hospitals":         total_hospitals,
        "near_expiry_units":       near_expiry_units,
        "critical_inventory_count": critical_count,
        "transfer_opportunities":  transfer_opps,
        "expiry_warnings":         expiry_warnings[:8],
        "low_inventory_warnings":  low_inv[:8],
        "last_updated":            datetime.now().strftime("%b %d, %Y %H:%M"),
    })


# ---------------------------------------------------------------------------
# Hospital list (for selector + map)
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
            "name":              row["hospital_name"],
            "city":              row["city"],
            "state":             row["state"],
            "latitude":          float(row["latitude"]),
            "longitude":         float(row["longitude"]),
            "total_units":       int(row["total_units"]),
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
# Blood type availability (all hospitals or filtered)
# ---------------------------------------------------------------------------

@app.route("/api/blood-types")
def blood_types():
    bt_filter = request.args.get("type")
    if bt_filter:
        return jsonify(get_blood_type_availability(df, bt_filter))

    # Summary totals for every type
    totals = df.groupby("blood_type")["units_available"].sum().to_dict()
    usage  = df.groupby("blood_type")["daily_usage"].sum().round(1).to_dict()
    return jsonify({
        "totals": {k: int(v) for k, v in totals.items()},
        "daily_usage": {k: float(v) for k, v in usage.items()},
    })


# ---------------------------------------------------------------------------
# Heatmap data
# ---------------------------------------------------------------------------

@app.route("/api/heatmap")
def heatmap():
    return jsonify(get_heatmap_data(df))


# ---------------------------------------------------------------------------
# Transfer recommendation
# ---------------------------------------------------------------------------

@app.route("/api/transfer-recommendation", methods=["POST"])
def transfer_recommendation():
    data = request.get_json() or {}
    hospital   = data.get("hospital")
    blood_type = data.get("blood_type")
    if not hospital or not blood_type:
        return jsonify({"error": "hospital and blood_type are required"}), 400

    result = find_transfer_partners(df, hospital, blood_type)
    return jsonify(result)


# ---------------------------------------------------------------------------
# AI shortage predictions
# ---------------------------------------------------------------------------

@app.route("/api/predictions")
def predictions():
    preds = get_predictions(df)

    by_level: dict = {0: [], 1: [], 2: [], 3: []}
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
        "top_critical":  by_level[3][:6],
        "top_high_risk": by_level[2][:6],
    })


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@app.route("/api/analytics")
def analytics():
    bt_inventory = df.groupby("blood_type")["units_available"].sum().to_dict()
    bt_usage     = df.groupby("blood_type")["daily_usage"].sum().round(1).to_dict()

    # Near-expiry units grouped by hospital
    near_exp_by_hosp: dict = {}
    for _, row in df.iterrows():
        d = days_until_expiry(str(row["expiration_date"]))
        if 0 <= d <= 7:
            h = row["hospital_name"]
            near_exp_by_hosp[h] = near_exp_by_hosp.get(h, 0) + int(row["units_available"])

    units_at_risk = sum(near_exp_by_hosp.values())

    # Hospital-level stress summary
    hospital_stress = []
    for hospital in df["hospital_name"].unique():
        h_df = df[df["hospital_name"] == hospital]
        avg_s = float(h_df["shortage_risk_score"].mean())
        hospital_stress.append({
            "hospital":          hospital,
            "city":              h_df.iloc[0]["city"],
            "total_units":       int(h_df["units_available"].sum()),
            "avg_shortage_score": round(avg_s, 3),
            "near_expiry_units": near_exp_by_hosp.get(hospital, 0),
            "stress_level": (
                "critical" if avg_s >= 1.5 else
                "warning"  if avg_s >= 0.6 else
                "stable"
            ),
        })
    hospital_stress.sort(key=lambda x: x["avg_shortage_score"], reverse=True)

    # Simulated 8-week demand trend for top blood types
    # Anchored to actual daily usage in the dataset, with week-over-week variation
    weekly_demand: dict = {}
    for bt in ["O+", "O-", "A+", "B+"]:
        base = float(df[df["blood_type"] == bt]["daily_usage"].sum()) * 7
        weekly_demand[bt] = [
            round(base * (0.82 + i * 0.025 + (i % 3) * 0.018 + (0.05 if i in [3, 6] else 0)), 1)
            for i in range(8)
        ]

    season_risk = df.groupby("season")["shortage_risk_score"].mean().round(3).to_dict()

    return jsonify({
        "blood_type_inventory":   {k: int(v)   for k, v in bt_inventory.items()},
        "blood_type_daily_usage": {k: float(v) for k, v in bt_usage.items()},
        "units_at_expiry_risk":   units_at_risk,
        "hospitals_under_stress": len([h for h in hospital_stress if h["stress_level"] != "stable"]),
        "hospital_stress":        hospital_stress,
        "weekly_demand_trends":   weekly_demand,
        "season_shortage_risk":   season_risk,
        "total_daily_demand":     round(float(df["daily_usage"].sum()), 1),
        "total_inventory":        int(df["units_available"].sum()),
        "inventory_days_coverage": round(
            float(df["units_available"].sum()) / max(float(df["daily_usage"].sum()), 0.1), 1
        ),
        "near_expiry_by_hospital": near_exp_by_hosp,
    })


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8080)
