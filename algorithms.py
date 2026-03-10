"""
algorithms.py
-------------
Operational logic for BloodBridge:
  - Expiry + low-inventory warnings
  - Haversine distance between hospitals
  - Shortage score (7-day demand / current units)
  - Best transfer partner ranking (by distance AND by stock)
  - Per-hospital inventory aggregation
  - Blood-type availability lookup
  - Heatmap stress score generation
"""

import math
import pandas as pd
from datetime import datetime

# Core utilities
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine great-circle distance between two geographic points (km)."""
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi   = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return round(2 * R * math.asin(math.sqrt(a)), 1)

def days_until_expiry(expiration_date_str: str) -> int:
    """Days from today until expiration. Negative = already expired."""
    try:
        exp = datetime.strptime(str(expiration_date_str), "%Y-%m-%d").date()
        return (exp - datetime.now().date()).days
    except Exception:
        return 999

def shortage_score(daily_usage: float, units_available: int, horizon_days: int = 7) -> float:
    """
    Ratio of expected 7-day demand to current supply.
    > 1.0 means demand outpaces supply within the horizon.
    """
    if units_available <= 0:
        return 99.0
    return round((daily_usage * horizon_days) / units_available, 3)

def _status_label(score: float, days_supply: float) -> str:
    if score >= 1.5 or days_supply < 2:
        return "critical"
    elif score >= 0.8 or days_supply < 5:
        return "high_risk"
    elif score >= 0.4 or days_supply < 10:
        return "warning"
    return "stable"

# Warning detectors
def get_expiry_warnings(df: pd.DataFrame, threshold_days: int = 7) -> list:
    """All batches expiring within threshold_days, sorted soonest-first."""
    warnings = []
    for _, row in df.iterrows():
        days = days_until_expiry(str(row["expiration_date"]))
        if 0 <= days <= threshold_days:
            warnings.append({
                "hospital":         row["hospital_name"],
                "city":             row["city"],
                "blood_type":       row["blood_type"],
                "units":            int(row["units_available"]),
                "days_until_expiry": days,
                "expiration_date":  str(row["expiration_date"]),
            })
    return sorted(warnings, key=lambda x: x["days_until_expiry"])

def get_low_inventory_warnings(df: pd.DataFrame, threshold_units: int = 10) -> list:
    """All entries with units below threshold, sorted by days of supply."""
    warnings = []
    for _, row in df.iterrows():
        units = int(row["units_available"])
        if units < threshold_units:
            daily = float(row["daily_usage"])
            warnings.append({
                "hospital":    row["hospital_name"],
                "city":        row["city"],
                "blood_type":  row["blood_type"],
                "units":       units,
                "daily_usage": round(daily, 1),
                "days_of_supply": round(units / max(daily, 0.1), 1),
            })
    return sorted(warnings, key=lambda x: x["days_of_supply"])

# Hospital summary
def get_hospital_summary(df: pd.DataFrame, hospital_name: str) -> list:
    """
    Aggregate all batches for a hospital, returning one entry per blood type
    with total units, soonest expiry, near-expiry flag, and shortage score.
    """
    h_df = df[df["hospital_name"] == hospital_name].copy()
    if h_df.empty:
        return []

    summary = []
    for bt in sorted(h_df["blood_type"].unique()):
        bt_rows = h_df[h_df["blood_type"] == bt]

        total_units   = int(bt_rows["units_available"].sum())
        avg_daily     = float(bt_rows["daily_usage"].mean())
        earliest_exp  = bt_rows["expiration_date"].min()
        days_exp      = days_until_expiry(str(earliest_exp))
        days_supply   = round(total_units / max(avg_daily, 0.1), 1)
        s_score       = shortage_score(avg_daily, total_units)

        # Units in batches expiring within 7 days
        near_exp_units = int(
            bt_rows[bt_rows["expiration_date"].apply(
                lambda d: 0 <= days_until_expiry(str(d)) <= 7
            )]["units_available"].sum()
        )

        summary.append({
            "blood_type":                bt,
            "total_units":               total_units,
            "daily_usage":               round(avg_daily, 1),
            "days_of_supply":            days_supply,
            "earliest_expiry":           str(earliest_exp),
            "days_until_earliest_expiry": days_exp,
            "near_expiry_units":         near_exp_units,
            "near_expiry_flag":          days_exp <= 7,
            "low_stock_flag":            total_units < 15,
            "shortage_score":            s_score,
            "status":                    _status_label(s_score, days_supply),
        })

    return summary

# Transfer partner finder
def find_transfer_partners(df: pd.DataFrame, requesting_hospital: str,
                           blood_type: str, min_surplus_units: int = 8) -> dict:
    """
    Find the best hospitals to source blood_type from.
    Returns:
        closest       – nearest hospital with adequate supply
        highest_stock – hospital with most units
        best_overall  – closest (primary recommendation)
        all_candidates – full ranked list
    """
    req_rows = df[df["hospital_name"] == requesting_hospital]
    if req_rows.empty:
        return {"error": "Requesting hospital not found", "candidates": []}

    req_lat = float(req_rows.iloc[0]["latitude"])
    req_lon = float(req_rows.iloc[0]["longitude"])

    # Hospitals other than the requester that have this blood type
    other_df = df[
        (df["hospital_name"] != requesting_hospital) &
        (df["blood_type"] == blood_type)
    ].copy()

    if other_df.empty:
        return {"error": f"No data for {blood_type} at other hospitals", "candidates": []}

    # Aggregate by hospital
    hospital_agg: dict = {}
    for _, row in other_df.iterrows():
        h = row["hospital_name"]
        if h not in hospital_agg:
            hospital_agg[h] = {
                "hospital":   h,
                "city":       row["city"],
                "state":      row["state"],
                "latitude":   float(row["latitude"]),
                "longitude":  float(row["longitude"]),
                "total_units": 0,
                "daily_usage": float(row["daily_usage"]),
            }
        hospital_agg[h]["total_units"] += int(row["units_available"])

    candidates = []
    for c in hospital_agg.values():
        if c["total_units"] < min_surplus_units:
            continue
        dist = haversine_km(req_lat, req_lon, c["latitude"], c["longitude"])
        surplus = max(0, c["total_units"] - int(c["daily_usage"] * 3))  # keep 3-day reserve
        c["distance_km"]              = dist
        c["estimated_transfer_hours"] = round(dist / 75, 1)   # ~75 km/h ground transport
        c["transferable_units"]       = surplus
        candidates.append(c)

    if not candidates:
        return {"error": f"No hospitals with adequate {blood_type} surplus", "candidates": []}

    by_distance = sorted(candidates, key=lambda x: x["distance_km"])
    by_stock    = sorted(candidates, key=lambda x: x["total_units"], reverse=True)

    return {
        "blood_type":    blood_type,
        "requesting":    requesting_hospital,
        "closest":       by_distance[0] if by_distance else None,
        "highest_stock": by_stock[0]    if by_stock    else None,
        "candidates":    by_distance,   # full list sorted by distance
    }

# Heatmap data
def get_heatmap_data(df: pd.DataFrame) -> list:
    """
    Compute a composite stress intensity score [0,1] per hospital for the map overlay.
    Aggregates across batches per blood type first so multi-batch hospitals
    aren't unfairly penalised for having older smaller batches alongside fresh ones.
    """
    results = []
    for hospital in df["hospital_name"].unique():
        h_df = df[df["hospital_name"] == hospital]
        lat  = float(h_df.iloc[0]["latitude"])
        lon  = float(h_df.iloc[0]["longitude"])
        city = h_df.iloc[0]["city"]

        # Aggregate by blood type (mirrors get_hospital_summary logic)
        blood_type_scores = []
        critical_types    = 0
        near_expiry_ct    = 0

        for bt in h_df["blood_type"].unique():
            bt_rows     = h_df[h_df["blood_type"] == bt]
            total_units = int(bt_rows["units_available"].sum())
            avg_daily   = float(bt_rows["daily_usage"].mean())
            s           = shortage_score(avg_daily, total_units)
            blood_type_scores.append(min(s, 5.0))
            if s >= 1.5:
                critical_types += 1

        # Near-expiry count at batch level (each near-expiry batch is a real risk)
        for _, row in h_df.iterrows():
            d = days_until_expiry(str(row["expiration_date"]))
            if 0 <= d <= 7:
                near_expiry_ct += 1

        avg_shortage = float(pd.Series(blood_type_scores).mean())
        # Weighted composite: shortage dominates, expiry exposure adds
        intensity = min(1.0, avg_shortage * 0.42 + critical_types * 0.06 + near_expiry_ct * 0.025)

        results.append({
            "hospital":            hospital,
            "city":                city,
            "lat":                 lat,
            "lon":                 lon,
            "stress_intensity":    round(intensity, 3),
            "critical_types":      critical_types,
            "near_expiry_batches": near_expiry_ct,
            "total_units":         int(h_df["units_available"].sum()),
            "avg_shortage_score":  round(avg_shortage, 3),
        })

    return sorted(results, key=lambda x: x["stress_intensity"], reverse=True)

# Blood-type availability across all hospitals
def get_blood_type_availability(df: pd.DataFrame, blood_type: str) -> list:
    """Which hospitals have blood_type and how much, with status labels."""
    bt_df = df[df["blood_type"] == blood_type].groupby("hospital_name").agg(
        total_units=("units_available", "sum"),
        city=("city", "first"),
        state=("state", "first"),
        latitude=("latitude", "first"),
        longitude=("longitude", "first"),
        daily_usage=("daily_usage", "mean"),
    ).reset_index()

    result = []
    for _, row in bt_df.iterrows():
        days_supply = round(row["total_units"] / max(row["daily_usage"], 0.1), 1)
        s_score     = shortage_score(float(row["daily_usage"]), int(row["total_units"]))
        result.append({
            "hospital":      row["hospital_name"],
            "city":          row["city"],
            "state":         row["state"],
            "lat":           float(row["latitude"]),
            "lon":           float(row["longitude"]),
            "units":         int(row["total_units"]),
            "days_of_supply": days_supply,
            "shortage_score": round(s_score, 3),
            "status":         _status_label(s_score, days_supply),
        })

    return sorted(result, key=lambda x: x["units"], reverse=True)
