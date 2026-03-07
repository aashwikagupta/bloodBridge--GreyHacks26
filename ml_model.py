"""
ml_model.py
-----------
BloodBridge shortage prediction engine.

Model choice: RandomForestClassifier
  Rationale: Blood shortage risk is driven by non-linear interactions between
  supply level, trauma rate, surgery schedule, season, and expiry proximity.
  Linear regression would underfit these interactions. Random Forest captures
  them without needing feature engineering beyond what's already in the data.
  It also gives feature importances for explainability — critical for healthcare.

Output risk levels:
  0 = Stable      (adequate supply, low demand pressure)
  1 = Watchlist   (buffer thinning — monitor closely)
  2 = High Risk   (shortage likely within 7 days)
  3 = Critical    (shortage imminent or already occurring)

Data augmentation:
  With only ~80 hospital+blood_type pairs, we augment training data by adding
  Gaussian noise scaled to each feature's variance (10x copies). This prevents
  overfitting while keeping the model demonstrably predictive.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from datetime import datetime
import warnings
warnings.filterwarnings("ignore")


RISK_LEVELS = {0: "Stable", 1: "Watchlist", 2: "High Risk", 3: "Critical"}
RISK_COLORS = {0: "#00e676",  1: "#ffab40",   2: "#ff7043",   3: "#ff1744"}
RISK_BG     = {0: "#00e67618", 1: "#ffab4018", 2: "#ff704318", 3: "#ff174418"}

SEASON_ENC  = {"Winter": 0, "Spring": 1, "Summer": 2, "Fall": 3}

FEATURE_NAMES = [
    "units_available",
    "daily_usage",
    "days_until_expiry",
    "surgery_schedule_score",
    "trauma_rate",
    "historical_demand",
    "season_enc",
    "shortage_score_7d",    # (daily_usage * 7) / units
    "days_of_supply",       # units / daily_usage
    "near_expiry_fraction", # fraction of units expiring <= 7 days
    "demand_pressure",      # actual daily_usage vs historical per-day demand
]


def _days_until_expiry(exp_str: str) -> int:
    try:
        exp = datetime.strptime(str(exp_str), "%Y-%m-%d").date()
        return max(0, (exp - datetime.now().date()).days)
    except Exception:
        return 30


def _assign_risk_label(shortage_7d: float, days_supply: float, near_exp_frac: float,
                       trauma_rate: float, surgery_score: float) -> int:
    """
    Rule-based labeling used to create supervised training targets.
    Combines supply-side stress, expiry exposure, and demand-side pressure.
    """
    # Immediate critical conditions
    if shortage_7d >= 2.0 or days_supply < 1.5:
        return 3
    if shortage_7d >= 1.2 or days_supply < 3.0 or (near_exp_frac > 0.6 and shortage_7d > 0.6):
        return 3 if (trauma_rate > 7.5 or surgery_score > 8.0) else 2
    # High risk
    if shortage_7d >= 0.75 or days_supply < 6.0 or near_exp_frac > 0.45:
        return 2
    # Watchlist
    if shortage_7d >= 0.35 or days_supply < 12.0 or near_exp_frac > 0.25:
        return 1
    return 0


def _extract_features(df: pd.DataFrame):
    """
    Group by hospital + blood_type, compute ML features for each pair.
    Returns (X array, y array, metadata list).
    """
    X_rows, y_labels, meta = [], [], []

    for (hospital, blood_type), group in df.groupby(["hospital_name", "blood_type"]):
        total_units      = float(group["units_available"].sum())
        avg_daily        = float(group["daily_usage"].mean())
        surgery_score    = float(group["surgery_schedule_score"].mean())
        trauma_rate      = float(group["trauma_rate"].mean())
        hist_demand      = float(group["historical_demand"].mean())
        season           = group["season"].iloc[0]
        season_enc       = SEASON_ENC.get(season, 0)

        # Earliest expiry across all batches
        days_exp = min(_days_until_expiry(str(d)) for d in group["expiration_date"])

        # Fraction of inventory in soon-to-expire batches
        near_exp_units = float(
            group[group["expiration_date"].apply(lambda d: _days_until_expiry(str(d)) <= 7)]
            ["units_available"].sum()
        )
        near_exp_frac = near_exp_units / max(total_units, 1.0)

        shortage_7d    = (avg_daily * 7) / max(total_units, 1.0)
        days_supply    = total_units / max(avg_daily, 0.1)
        demand_pressure = avg_daily / max(hist_demand / 7.0, 0.1)

        feat = [
            total_units, avg_daily, days_exp,
            surgery_score, trauma_rate, hist_demand,
            season_enc, shortage_7d, days_supply,
            near_exp_frac, demand_pressure,
        ]

        label = _assign_risk_label(shortage_7d, days_supply, near_exp_frac,
                                   trauma_rate, surgery_score)

        X_rows.append(feat)
        y_labels.append(label)
        meta.append({
            "hospital":          hospital,
            "blood_type":        blood_type,
            "total_units":       int(total_units),
            "daily_usage":       round(avg_daily, 1),
            "days_of_supply":    round(days_supply, 1),
            "shortage_score_7d": round(shortage_7d, 3),
            "near_expiry_frac":  round(near_exp_frac, 3),
            "surgery_score":     round(surgery_score, 1),
            "trauma_rate":       round(trauma_rate, 1),
            "season":            season,
            "days_until_expiry": days_exp,
        })

    return np.array(X_rows, dtype=float), np.array(y_labels, dtype=int), meta


def _augment(X: np.ndarray, y: np.ndarray, copies: int = 12) -> tuple:
    """
    Data augmentation via scaled Gaussian noise.
    Each copy adds noise proportional to feature std, keeping labels identical.
    This gives the RF enough diversity to generalize without generating fake labels.
    """
    Xs, ys = [X], [y]
    std = X.std(axis=0) + 1e-8
    for _ in range(copies):
        noise = np.random.normal(0, 0.09, X.shape) * std
        Xs.append(X + noise)
        ys.append(y)
    return np.vstack(Xs), np.concatenate(ys)


def _explain(meta: dict, risk_level: int) -> str:
    """Generate a plain-English explanation for the predicted risk level."""
    bt      = meta["blood_type"]
    hosp    = meta["hospital"].split()[0]
    reasons = []

    if meta["shortage_score_7d"] >= 1.5:
        reasons.append("7-day projected demand is >1.5x current supply")
    elif meta["shortage_score_7d"] >= 0.8:
        reasons.append("demand is outpacing available supply")

    if meta["days_of_supply"] < 2:
        reasons.append(f"only {meta['days_of_supply']:.1f} days of supply remain")
    elif meta["days_of_supply"] < 6:
        reasons.append(f"stock exhaustion projected in ~{meta['days_of_supply']:.1f} days")

    if meta["near_expiry_frac"] > 0.45:
        reasons.append(f"{int(meta['near_expiry_frac']*100)}% of units expire within 7 days")

    if meta["surgery_score"] >= 8.0:
        reasons.append("high surgical case load elevates consumption")

    if meta["trauma_rate"] >= 7.5:
        reasons.append("elevated trauma intake is driving demand")

    if meta["season"] in ["Winter", "Summer"]:
        reasons.append(f"{meta['season']} seasonality typically increases blood demand")

    if not reasons:
        if risk_level == 0:
            return f"{bt} inventory is stable with healthy supply margins."
        reasons.append("compounding risk factors detected across supply metrics")

    prefix = {
        3: f"CRITICAL — {bt} at {hosp}",
        2: f"{bt} High Risk at {hosp}",
        1: f"{bt} on Watchlist at {hosp}",
        0: f"{bt} is Stable at {hosp}",
    }[risk_level]

    return f"{prefix}: {'; '.join(reasons[:3])}."


class BloodShortagePredictor:
    def __init__(self):
        # n_estimators=150 balances accuracy and inference speed
        self.model = RandomForestClassifier(
            n_estimators=150,
            max_depth=9,
            min_samples_leaf=2,
            class_weight="balanced",
            random_state=42,
        )
        self.trained = False
        self.feature_importances: dict = {}

    def train(self, df: pd.DataFrame):
        X, y, _ = _extract_features(df)
        X_aug, y_aug = _augment(X, y)
        self.model.fit(X_aug, y_aug)
        self.trained = True
        self.feature_importances = dict(zip(FEATURE_NAMES, self.model.feature_importances_))
        print("[BloodBridge] Shortage prediction model trained.")
        return self

    def predict(self, df: pd.DataFrame) -> list:
        X, _, meta_list = _extract_features(df)
        if not self.trained:
            raise RuntimeError("Model not trained. Call train() first.")

        probs = self.model.predict_proba(X)
        preds = self.model.predict(X)

        results = []
        for i, meta in enumerate(meta_list):
            rl   = int(preds[i])
            conf = float(max(probs[i]))
            results.append({
                **meta,
                "risk_level":   rl,
                "risk_label":   RISK_LEVELS[rl],
                "risk_color":   RISK_COLORS[rl],
                "risk_bg":      RISK_BG[rl],
                "confidence":   round(conf, 2),
                "explanation":  _explain(meta, rl),
            })

        return sorted(results, key=lambda x: (x["risk_level"], x["shortage_score_7d"]), reverse=True)

    def feature_importance_report(self) -> list:
        items = sorted(self.feature_importances.items(), key=lambda x: x[1], reverse=True)
        return [{"feature": k, "importance": round(v, 4)} for k, v in items]


# ---------------------------------------------------------------------------
# Module-level singleton — app.py imports these two functions
# ---------------------------------------------------------------------------
_predictor = BloodShortagePredictor()


def train_model(df: pd.DataFrame) -> BloodShortagePredictor:
    _predictor.train(df)
    return _predictor


def get_predictions(df: pd.DataFrame) -> list:
    if not _predictor.trained:
        _predictor.train(df)
    return _predictor.predict(df)


def get_feature_importance() -> list:
    return _predictor.feature_importance_report()
