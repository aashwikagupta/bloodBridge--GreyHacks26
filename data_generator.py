"""
data_generator.py
-----------------
Generates synthetic hospital blood inventory dataset for BloodBridge.
~192 rows representing current inventory batches across 10 regional hospitals.

Design decisions:
- 4 hospital profiles: high_volume, moderate, stressed, surplus
- 2-3 donation batches per blood type per hospital (different expiry dates)
- Intentional demo patterns: O- critical at Northside + Central Valley,
  near-expiry cluster at Elmwood, strong surplus at Harborview/Greenfield
- O+ and O- have higher base demand (universal donor / emergency priority)
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import random

random.seed(42)
np.random.seed(42)

HOSPITALS = [
    {"name": "St. Mary's Medical Center",    "city": "Chicago",      "state": "IL", "lat": 41.8781, "lon": -87.6298, "profile": "high_volume"},
    {"name": "Riverside General Hospital",   "city": "Milwaukee",    "state": "WI", "lat": 43.0389, "lon": -87.9065, "profile": "moderate"},
    {"name": "Northside Community Hospital", "city": "Minneapolis",  "state": "MN", "lat": 44.9778, "lon": -93.2650, "profile": "stressed"},
    {"name": "Lakeview Medical Institute",   "city": "Detroit",      "state": "MI", "lat": 42.3314, "lon": -83.0458, "profile": "moderate"},
    {"name": "Mercy Central Hospital",       "city": "Indianapolis", "state": "IN", "lat": 39.7684, "lon": -86.1581, "profile": "high_volume"},
    {"name": "Elmwood Regional Medical",     "city": "Columbus",     "state": "OH", "lat": 39.9612, "lon": -82.9988, "profile": "stressed"},
    {"name": "Harborview Hospital",          "city": "Cleveland",    "state": "OH", "lat": 41.4993, "lon": -81.6944, "profile": "surplus"},
    {"name": "Summit Health Center",         "city": "Pittsburgh",   "state": "PA", "lat": 40.4406, "lon": -79.9959, "profile": "moderate"},
    {"name": "Central Valley Hospital",      "city": "Cincinnati",   "state": "OH", "lat": 39.1031, "lon": -84.5120, "profile": "stressed"},
    {"name": "Greenfield Medical Campus",    "city": "Louisville",   "state": "KY", "lat": 38.2527, "lon": -85.7585, "profile": "surplus"},
]

BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]

# Base daily demand per blood type — O types are high-demand due to universal compatibility
DEMAND_BASE = {
    "O+": 7.2, "O-": 5.8,
    "A+": 4.5, "A-": 2.8,
    "B+": 3.9, "B-": 2.1,
    "AB+": 1.8, "AB-": 1.2,
}

# Target days-of-stock per profile (total across all batches for a blood type).
# This makes the supply semantics intuitive: stressed = days of stock, not a fraction.
PROFILE_SUPPLY_DAYS = {
    "high_volume": (9,  18),   # modest buffer — high throughput burns through stock quickly
    "moderate":    (14, 28),   # comfortable 2-4 week window
    "stressed":    (2,   6),   # critically low — the problem hospitals in the demo
    "surplus":     (22, 42),   # well-stocked, strong transfer candidates
}

# Surgery load and trauma rates by profile
PROFILE_SURGERY = {
    "high_volume": (7.5, 9.5),
    "moderate":    (4.0, 7.0),
    "stressed":    (5.5, 8.5),   # stressed hospitals often have high activity
    "surplus":     (2.5, 5.5),
}

PROFILE_TRAUMA = {
    "high_volume": (5.5, 9.0),
    "moderate":    (3.0, 6.5),
    "stressed":    (6.0, 9.0),
    "surplus":     (2.0, 5.0),
}

# Seasonal demand modifier
SEASON_DEMAND = {"Winter": 1.15, "Spring": 0.95, "Summer": 1.05, "Fall": 1.00}


def get_current_season():
    month = datetime.now().month
    if month in [12, 1, 2]:
        return "Winter"
    elif month in [3, 4, 5]:
        return "Spring"
    elif month in [6, 7, 8]:
        return "Summer"
    return "Fall"


def generate_dataset():
    today = datetime.now().date()
    season = get_current_season()
    season_mult = SEASON_DEMAND[season]
    rows = []

    for hospital in HOSPITALS:
        profile = hospital["profile"]

        surgery_score = round(random.uniform(*PROFILE_SURGERY[profile]), 1)
        trauma_rate   = round(random.uniform(*PROFILE_TRAUMA[profile]), 1)

        for blood_type in BLOOD_TYPES:
            base_daily   = DEMAND_BASE[blood_type] * season_mult
            actual_daily = round(base_daily * random.uniform(0.85, 1.25), 1)

            # High-volume hospitals track 3 batches; others 2
            num_batches = 3 if profile == "high_volume" else 2

            # Total units for this hospital+blood_type = days_target × daily_usage
            days_target  = random.uniform(*PROFILE_SUPPLY_DAYS[profile])
            total_target = actual_daily * days_target

            for batch_idx in range(num_batches):
                # Spread expiry dates realistically across the 42-day RBC lifetime
                if batch_idx == 0:
                    days_out = random.randint(18, 42)    # fresh batch
                elif batch_idx == 1:
                    # Older batch — stressed hospitals are sitting on aged stock
                    days_out = random.randint(2, 10) if profile == "stressed" else random.randint(7, 25)
                else:
                    days_out = random.randint(10, 32)    # third batch (high_volume only)

                # Override: force near-expiry demo cluster at Elmwood batch 1
                if hospital["name"] == "Elmwood Regional Medical" and batch_idx == 1:
                    days_out = random.randint(1, 5)

                expiry_date = today + timedelta(days=days_out)

                # Split total_target roughly evenly across batches with some noise
                batch_frac = random.uniform(0.25, 0.45) if num_batches == 3 else random.uniform(0.4, 0.6)
                base_units = total_target * batch_frac if batch_idx < num_batches - 1 else total_target

                # Critical shortage for O- and O+ at specific demo hospitals (override)
                if hospital["name"] in ["Northside Community Hospital", "Central Valley Hospital"]:
                    if blood_type in ["O-", "O+"]:
                        base_units = random.uniform(2, 8)

                units = max(1, int(base_units * random.uniform(0.85, 1.15)))

                historical_demand = round(actual_daily * 7 * random.uniform(0.88, 1.18), 1)
                shortage_risk     = round((actual_daily * 7) / max(units, 1), 3)
                shortage_risk     = min(shortage_risk, 12.0)

                rows.append({
                    "hospital_name":          hospital["name"],
                    "city":                   hospital["city"],
                    "state":                  hospital["state"],
                    "latitude":               hospital["lat"],
                    "longitude":              hospital["lon"],
                    "blood_type":             blood_type,
                    "units_available":        units,
                    "expiration_date":        expiry_date.strftime("%Y-%m-%d"),
                    "daily_usage":            actual_daily,
                    "season":                 season,
                    "surgery_schedule_score": surgery_score,
                    "trauma_rate":            trauma_rate,
                    "historical_demand":      historical_demand,
                    "shortage_risk_score":    shortage_risk,
                    "last_updated":           datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                })

    df = pd.DataFrame(rows)
    print(f"[BloodBridge] Generated {len(df)} inventory records across {df['hospital_name'].nunique()} hospitals.")
    return df


if __name__ == "__main__":
    df = generate_dataset()
    df.to_csv("dataset.csv", index=False)
    print(df[["hospital_name", "blood_type", "units_available", "shortage_risk_score"]].head(24))
