"""
data_generator.py
-----------------
BloodBridge — Northeast Regional Blood Network synthetic dataset.

Coverage: 35 hospitals and blood centers across NY, NJ, PA, MA, CT, RI, VT, NH, ME.
Generates ~700 inventory records with realistic shortage patterns.

Demo patterns baked in:
  - O-/O+ critical shortage at Bellevue + Temple (urban trauma centers)
  - Near-expiry cluster at Rhode Island Hospital + Eastern Maine MC
  - Strong surplus at blood center hubs for transfer demos
  - High-volume academic centers with sustained demand pressure
  - Geographically spread for meaningful map + transfer routing
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import random

random.seed(42)
np.random.seed(42)

HOSPITALS = [
    #New York City — Manhattan 
    {"name": "NY-Presbyterian / Weill Cornell",   "city": "New York",       "state": "NY", "lat": 40.7649, "lon": -73.9541, "profile": "high_volume"},
    {"name": "Mount Sinai Medical Center",         "city": "New York",       "state": "NY", "lat": 40.7900, "lon": -73.9526, "profile": "high_volume"},
    {"name": "Bellevue Hospital Center",           "city": "New York",       "state": "NY", "lat": 40.7394, "lon": -73.9759, "profile": "stressed"},
    {"name": "NYU Langone Medical Center",         "city": "New York",       "state": "NY", "lat": 40.7420, "lon": -73.9756, "profile": "high_volume"},
    {"name": "New York Blood Center",              "city": "New York",       "state": "NY", "lat": 40.7711, "lon": -73.9551, "profile": "surplus"},
    {"name": "Lenox Hill Hospital",                "city": "New York",       "state": "NY", "lat": 40.7719, "lon": -73.9596, "profile": "moderate"},
    {"name": "Harlem Hospital Center",             "city": "New York",       "state": "NY", "lat": 40.8110, "lon": -73.9403, "profile": "stressed"},
    #New York City — Bronx 
    {"name": "Montefiore Medical Center",          "city": "Bronx",          "state": "NY", "lat": 40.8826, "lon": -73.8781, "profile": "stressed"},
    {"name": "Lincoln Medical Center",             "city": "Bronx",          "state": "NY", "lat": 40.8157, "lon": -73.9257, "profile": "stressed"},
    {"name": "Jacobi Medical Center",              "city": "Bronx",          "state": "NY", "lat": 40.8528, "lon": -73.8453, "profile": "moderate"},
    #New York City — Brooklyn 
    {"name": "Kings County Hospital Center",       "city": "Brooklyn",       "state": "NY", "lat": 40.6556, "lon": -73.9443, "profile": "stressed"},
    {"name": "Maimonides Medical Center",          "city": "Brooklyn",       "state": "NY", "lat": 40.6186, "lon": -73.9961, "profile": "moderate"},
    {"name": "NYU Langone Brooklyn",               "city": "Brooklyn",       "state": "NY", "lat": 40.6419, "lon": -73.9609, "profile": "moderate"},
    {"name": "Methodist Hospital Brooklyn",        "city": "Brooklyn",       "state": "NY", "lat": 40.6501, "lon": -73.9770, "profile": "moderate"},
    #New York City — Queens 
    {"name": "Long Island Jewish Medical Center",  "city": "Queens",         "state": "NY", "lat": 40.7544, "lon": -73.7072, "profile": "high_volume"},
    {"name": "Jamaica Hospital Medical Center",    "city": "Queens",         "state": "NY", "lat": 40.6999, "lon": -73.7935, "profile": "moderate"},
    {"name": "Elmhurst Hospital Center",           "city": "Queens",         "state": "NY", "lat": 40.7447, "lon": -73.8785, "profile": "stressed"},
    # New York City — Staten Island 
    {"name": "Staten Island University Hospital",  "city": "Staten Island",  "state": "NY", "lat": 40.5795, "lon": -74.0948, "profile": "moderate"},
    #Long Island 
    {"name": "Stony Brook University Hospital",    "city": "Stony Brook",    "state": "NY", "lat": 40.9126, "lon": -73.1201, "profile": "high_volume"},
    {"name": "Good Samaritan University Hospital", "city": "West Islip",     "state": "NY", "lat": 40.7251, "lon": -73.4125, "profile": "moderate"},
    {"name": "Winthrop University Hospital",       "city": "Mineola",        "state": "NY", "lat": 40.7467, "lon": -73.5989, "profile": "moderate"},
    {"name": "Northwell Health — South Shore",     "city": "Bay Shore",      "state": "NY", "lat": 40.7282, "lon": -73.2481, "profile": "moderate"},
    #Westchester / Hudson Valley 
    {"name": "White Plains Hospital",              "city": "White Plains",   "state": "NY", "lat": 41.0340, "lon": -73.7629, "profile": "moderate"},
    {"name": "Westchester Medical Center",         "city": "Valhalla",       "state": "NY", "lat": 41.0968, "lon": -73.8523, "profile": "high_volume"},
    #Upstate New York 
    {"name": "Albany Medical Center",              "city": "Albany",         "state": "NY", "lat": 42.6526, "lon": -73.7562, "profile": "moderate"},
    {"name": "Upstate Medical University",         "city": "Syracuse",       "state": "NY", "lat": 43.0481, "lon": -76.1474, "profile": "moderate"},
    {"name": "Erie County Medical Center",         "city": "Buffalo",        "state": "NY", "lat": 42.8864, "lon": -78.8784, "profile": "stressed"},
    {"name": "Strong Memorial Hospital",           "city": "Rochester",      "state": "NY", "lat": 43.1247, "lon": -77.6093, "profile": "high_volume"},
    {"name": "Samaritan Medical Center",           "city": "Watertown",      "state": "NY", "lat": 43.9748, "lon": -75.9108, "profile": "moderate"},
    #New Jersey 
    {"name": "Hackensack University Medical Ctr",  "city": "Hackensack",     "state": "NJ", "lat": 40.8839, "lon": -74.0439, "profile": "surplus"},
    {"name": "RWJBarnabas Medical Center",         "city": "Newark",         "state": "NJ", "lat": 40.7357, "lon": -74.1724, "profile": "moderate"},
    {"name": "Cooper University Hospital",         "city": "Camden",         "state": "NJ", "lat": 39.9440, "lon": -75.1160, "profile": "stressed"},
    {"name": "Morristown Medical Center",          "city": "Morristown",     "state": "NJ", "lat": 40.7968, "lon": -74.4774, "profile": "moderate"},
    {"name": "AtlantiCare Regional Medical Ctr",   "city": "Atlantic City",  "state": "NJ", "lat": 39.3643, "lon": -74.4229, "profile": "moderate"},
    {"name": "Overlook Medical Center",            "city": "Summit",         "state": "NJ", "lat": 40.6951, "lon": -74.3701, "profile": "moderate"},
    {"name": "Saint Barnabas Medical Center",      "city": "Livingston",     "state": "NJ", "lat": 40.7879, "lon": -74.3224, "profile": "surplus"},
    {"name": "Robert Wood Johnson University",     "city": "New Brunswick",  "state": "NJ", "lat": 40.5027, "lon": -74.4479, "profile": "high_volume"},
    {"name": "JFK University Medical Center",      "city": "Edison",         "state": "NJ", "lat": 40.5215, "lon": -74.3487, "profile": "moderate"},
    {"name": "Virtua Health — Marlton",            "city": "Marlton",        "state": "NJ", "lat": 39.8913, "lon": -74.9219, "profile": "moderate"},
    #Massachusetts
    {"name": "Massachusetts General Hospital",     "city": "Boston",         "state": "MA", "lat": 42.3628, "lon": -71.0686, "profile": "high_volume"},
    {"name": "Brigham and Women's Hospital",       "city": "Boston",         "state": "MA", "lat": 42.3359, "lon": -71.1067, "profile": "high_volume"},
    {"name": "Boston Medical Center",              "city": "Boston",         "state": "MA", "lat": 42.3355, "lon": -71.0711, "profile": "stressed"},
    {"name": "Tufts Medical Center",               "city": "Boston",         "state": "MA", "lat": 42.3492, "lon": -71.0629, "profile": "high_volume"},
    {"name": "Beth Israel Deaconess Medical Ctr",  "city": "Boston",         "state": "MA", "lat": 42.3380, "lon": -71.1053, "profile": "high_volume"},
    {"name": "Northeast Blood Services (ARC)",     "city": "Boston",         "state": "MA", "lat": 42.3601, "lon": -71.0589, "profile": "surplus"},
    {"name": "UMass Memorial Medical Center",      "city": "Worcester",      "state": "MA", "lat": 42.2626, "lon": -71.7938, "profile": "moderate"},
    {"name": "Baystate Medical Center",            "city": "Springfield",    "state": "MA", "lat": 42.1051, "lon": -72.5900, "profile": "moderate"},
    {"name": "Lowell General Hospital",            "city": "Lowell",         "state": "MA", "lat": 42.6356, "lon": -71.3145, "profile": "moderate"},
    {"name": "South Shore Hospital",               "city": "Weymouth",       "state": "MA", "lat": 42.1787, "lon": -70.9410, "profile": "moderate"},
    {"name": "Lahey Hospital & Medical Center",    "city": "Burlington",     "state": "MA", "lat": 42.4973, "lon": -71.1990, "profile": "surplus"},
    #Connecticut 
    {"name": "Yale New Haven Hospital",            "city": "New Haven",      "state": "CT", "lat": 41.3042, "lon": -72.9349, "profile": "high_volume"},
    {"name": "Hartford Hospital",                  "city": "Hartford",       "state": "CT", "lat": 41.7637, "lon": -72.6901, "profile": "moderate"},
    {"name": "Bridgeport Hospital",                "city": "Bridgeport",     "state": "CT", "lat": 41.1665, "lon": -73.1957, "profile": "moderate"},
    {"name": "Stamford Hospital",                  "city": "Stamford",       "state": "CT", "lat": 41.0534, "lon": -73.5387, "profile": "moderate"},
    {"name": "Waterbury Hospital",                 "city": "Waterbury",      "state": "CT", "lat": 41.5562, "lon": -73.0390, "profile": "stressed"},
    {"name": "St. Francis Hospital Hartford",      "city": "Hartford",       "state": "CT", "lat": 41.7612, "lon": -72.7004, "profile": "moderate"},
    #Rhode Island 
    {"name": "Rhode Island Hospital",              "city": "Providence",     "state": "RI", "lat": 41.8236, "lon": -71.4222, "profile": "high_volume"},
    {"name": "Miriam Hospital",                    "city": "Providence",     "state": "RI", "lat": 41.8380, "lon": -71.3972, "profile": "moderate"},
    {"name": "Kent County Hospital",               "city": "Warwick",        "state": "RI", "lat": 41.7193, "lon": -71.4626, "profile": "moderate"},
    #Vermont
    {"name": "UVM Medical Center",                 "city": "Burlington",     "state": "VT", "lat": 44.4759, "lon": -73.2121, "profile": "moderate"},
    {"name": "Rutland Regional Medical Center",    "city": "Rutland",        "state": "VT", "lat": 43.6106, "lon": -72.9726, "profile": "moderate"},
    #New Hampshire
    {"name": "Dartmouth-Hitchcock Medical Center", "city": "Lebanon",        "state": "NH", "lat": 43.6435, "lon": -72.3276, "profile": "surplus"},
    {"name": "Concord Hospital",                   "city": "Concord",        "state": "NH", "lat": 43.2081, "lon": -71.5376, "profile": "moderate"},
    {"name": "Portsmouth Regional Hospital",       "city": "Portsmouth",     "state": "NH", "lat": 43.0784, "lon": -70.7626, "profile": "moderate"},
    # Maine 
    {"name": "Maine Medical Center",               "city": "Portland",       "state": "ME", "lat": 43.6591, "lon": -70.2568, "profile": "moderate"},
    {"name": "Eastern Maine Medical Center",       "city": "Bangor",         "state": "ME", "lat": 44.8016, "lon": -68.7712, "profile": "stressed"},
    {"name": "Central Maine Medical Center",       "city": "Lewiston",       "state": "ME", "lat": 44.1003, "lon": -70.2259, "profile": "moderate"},
    {"name": "Mercy Hospital Portland",            "city": "Portland",       "state": "ME", "lat": 43.6474, "lon": -70.2703, "profile": "moderate"},
    # Pennsylvania
    {"name": "Penn Medicine - HUP",                "city": "Philadelphia",   "state": "PA", "lat": 39.9498, "lon": -75.1939, "profile": "high_volume"},
    {"name": "Temple University Hospital",         "city": "Philadelphia",   "state": "PA", "lat": 39.9786, "lon": -75.1499, "profile": "stressed"},
    {"name": "Jefferson Hospital",                 "city": "Philadelphia",   "state": "PA", "lat": 39.9496, "lon": -75.1577, "profile": "moderate"},
    {"name": "UPMC Presbyterian",                  "city": "Pittsburgh",     "state": "PA", "lat": 40.4438, "lon": -79.9601, "profile": "high_volume"},
    {"name": "Lehigh Valley Hospital",             "city": "Allentown",      "state": "PA", "lat": 40.5929, "lon": -75.4697, "profile": "moderate"},
    {"name": "Reading Hospital",                   "city": "Reading",        "state": "PA", "lat": 40.3296, "lon": -75.9263, "profile": "moderate"},
    {"name": "Lancaster General Hospital",         "city": "Lancaster",      "state": "PA", "lat": 40.0427, "lon": -76.3149, "profile": "moderate"},
    {"name": "Geisinger Medical Center",           "city": "Danville",       "state": "PA", "lat": 40.9626, "lon": -76.6157, "profile": "surplus"},
    # Delaware 
    {"name": "Christiana Hospital",                "city": "Newark",         "state": "DE", "lat": 39.6817, "lon": -75.6572, "profile": "high_volume"},
    # Maryland 
    {"name": "Johns Hopkins Hospital",             "city": "Baltimore",      "state": "MD", "lat": 39.2963, "lon": -76.5927, "profile": "high_volume"},
    {"name": "University of Maryland Medical Ctr", "city": "Baltimore",      "state": "MD", "lat": 39.2972, "lon": -76.6243, "profile": "high_volume"},
    {"name": "Sinai Hospital of Baltimore",        "city": "Baltimore",      "state": "MD", "lat": 39.3622, "lon": -76.6559, "profile": "moderate"},
]

BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]

# Base daily demand — O types are highest due to universal-donor / emergency use
DEMAND_BASE = {
    "O+": 7.2, "O-": 5.8,
    "A+": 4.5, "A-": 2.8,
    "B+": 3.9, "B-": 2.1,
    "AB+": 1.8, "AB-": 1.2,
}

# Target days-of-stock range by hospital profile
PROFILE_SUPPLY_DAYS = {
    "high_volume": (9,  18),   # High throughput burns stock fast
    "moderate":    (14, 28),   # Comfortable 2-4 week buffer
    "stressed":    (2,   6),   # Critically low — demo problem facilities
    "surplus":     (22, 42),   # Well-stocked — strong transfer candidates
}

PROFILE_SURGERY = {
    "high_volume": (7.5, 9.5),
    "moderate":    (4.0, 7.0),
    "stressed":    (5.5, 8.5),
    "surplus":     (2.5, 5.5),
}

PROFILE_TRAUMA = {
    "high_volume": (5.5, 9.0),
    "moderate":    (3.0, 6.5),
    "stressed":    (6.0, 9.0),
    "surplus":     (2.0, 5.0),
}

SEASON_DEMAND = {"Winter": 1.15, "Spring": 0.95, "Summer": 1.05, "Fall": 1.00}

# Demo: forced critical O-/O+ shortage at these urban trauma hospitals
CRITICAL_SHORTAGE_HOSPITALS = {"Bellevue Hospital Center", "Temple University Hospital"}

# Demo: forced near-expiry batch at these facilities (creates visible warning cluster)
NEAR_EXPIRY_DEMO_HOSPITALS = {"Rhode Island Hospital", "Eastern Maine Medical Center"}


def get_current_season() -> str:
    m = datetime.now().month
    if m in [12, 1, 2]:  return "Winter"
    if m in [3,  4, 5]:  return "Spring"
    if m in [6,  7, 8]:  return "Summer"
    return "Fall"


def generate_dataset() -> pd.DataFrame:
    today       = datetime.now().date()
    season      = get_current_season()
    season_mult = SEASON_DEMAND[season]
    rows: list  = []

    for hospital in HOSPITALS:
        profile       = hospital["profile"]
        surgery_score = round(random.uniform(*PROFILE_SURGERY[profile]), 1)
        trauma_rate   = round(random.uniform(*PROFILE_TRAUMA[profile]), 1)

        for blood_type in BLOOD_TYPES:
            base_daily   = DEMAND_BASE[blood_type] * season_mult
            actual_daily = round(base_daily * random.uniform(0.85, 1.25), 1)

            num_batches  = 3 if profile == "high_volume" else 2
            days_target  = random.uniform(*PROFILE_SUPPLY_DAYS[profile])
            total_target = actual_daily * days_target

            for batch_idx in range(num_batches):
                # Assign expiry dates by batch age
                if batch_idx == 0:
                    days_out = random.randint(18, 42)       # Fresh batch
                elif batch_idx == 1:
                    if profile == "stressed":
                        days_out = random.randint(2, 10)    # Stressed = aged stock
                    else:
                        days_out = random.randint(7, 25)
                else:
                    days_out = random.randint(10, 32)       # Third batch (high_volume)

                # Override: force near-expiry demo cluster
                if hospital["name"] in NEAR_EXPIRY_DEMO_HOSPITALS and batch_idx == 1:
                    days_out = random.randint(1, 5)

                expiry_date = today + timedelta(days=days_out)

                # Batch unit split
                batch_frac = (
                    random.uniform(0.25, 0.45) if num_batches == 3
                    else random.uniform(0.4, 0.6)
                )
                base_units = (
                    total_target * batch_frac if batch_idx < num_batches - 1
                    else total_target
                )

                # Override: force critical O-/O+ shortage at demo hospitals
                if hospital["name"] in CRITICAL_SHORTAGE_HOSPITALS and blood_type in ("O-", "O+"):
                    base_units = random.uniform(2, 8)

                units             = max(1, int(base_units * random.uniform(0.85, 1.15)))
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
    print(f"[BloodBridge] Generated {len(df)} records across {df['hospital_name'].nunique()} hospitals.")
    return df


if __name__ == "__main__":
    df = generate_dataset()
    df.to_csv("dataset.csv", index=False)
    print(df[["hospital_name", "blood_type", "units_available", "shortage_risk_score"]].head(32))
