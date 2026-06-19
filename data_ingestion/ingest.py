"""
Ingestion script for the Invertix multi-tenant solar plant dataset.

Reads the data/ folder (one subfolder per company) and populates the
database created by app/db/migrations/001_schema.sql.

IMPORTANT: this script connects directly with psycopg2 using the
database's superuser/owner role, NOT through the app's normal request
path. It intentionally bypasses Row Level Security: RLS filters based
on session variables that represent a *logged-in user*, but ingestion
has no logged-in user — it's the trusted process that creates the data
for every company at once. The normal app code (app/db/session.py)
must never connect this way; only this script does.

Usage:
    python data_ingestion/ingest.py

Requires DATABASE_URL in your .env file or environment.
"""

import os
import sys
import json
import csv
from pathlib import Path
from datetime import datetime

import psycopg2
from psycopg2.extras import execute_values

# ---------- config ----------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    # fall back to reading a simple .env file if python-dotenv isn't set up
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                DATABASE_URL = line.split("=", 1)[1].strip().strip('"').strip("'")
                break

if not DATABASE_URL:
    print("ERROR: DATABASE_URL not found in environment or .env file.")
    sys.exit(1)


def get_connection():
    return psycopg2.connect(DATABASE_URL)


# ---------- helpers ----------

def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_csv_rows(path: Path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def flatten_parameters(params_list):
    """Convert [{"Key": "Region", "Value": "North"}, ...] into {"Region": "North", ...}."""
    return {p["Key"]: p["Value"] for p in params_list}


# ---------- ingestion steps ----------

def ingest_company(cur, company_dir: Path):
    company = load_json(company_dir / "company.json")
    company_id = company["company_id"]
    cur.execute(
        "INSERT INTO companies (id, name) VALUES (%s, %s) "
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
        (company_id, company["display_name"]),
    )
    print(f"  company: {company_id}")
    return company_id


def ingest_users(cur, company_dir: Path, company_id: str):
    rows = load_csv_rows(company_dir / "users.csv")
    for row in rows:
        cur.execute(
            "INSERT INTO users (id, company_id, email, role, access_scope) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  email = EXCLUDED.email, role = EXCLUDED.role, access_scope = EXCLUDED.access_scope",
            (row["user_id"], company_id, row["email"], row["role"], row["access_scope"]),
        )
    print(f"  users: {len(rows)}")


def ingest_plants(cur, company_dir: Path, company_id: str):
    plants = load_json(company_dir / "api" / "GET_api_Plant.json")
    for plant in plants:
        params = flatten_parameters(plant.get("Parameters", []))
        cur.execute(
            "INSERT INTO plants (id, company_id, name, parameters) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  name = EXCLUDED.name, parameters = EXCLUDED.parameters",
            (plant["Id"], company_id, plant["Name"], json.dumps(params)),
        )
    print(f"  plants: {len(plants)}")
    return [p["Id"] for p in plants]


def ingest_elements_and_datasources(cur, company_dir: Path, plant_id: int):
    plant_api_dir = company_dir / "api" / f"plant_{plant_id}"

    elements = load_json(plant_api_dir / "GET_api_Plant_{plantId}_Element.json")
    for el in elements:
        cur.execute(
            "INSERT INTO elements (id, plant_id, name, type_string) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  name = EXCLUDED.name, type_string = EXCLUDED.type_string",
            (el["Identifier"], el["ParentId"], el["Name"], el["TypeString"]),
        )

    datasources = load_json(plant_api_dir / "GET_api_Plant_{plantId}_Datasource.json")
    for ds in datasources:
        cur.execute(
            "INSERT INTO datasources (id, element_id, name, units, aggregation_type) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "  name = EXCLUDED.name, units = EXCLUDED.units",
            # aggregation_type filled in separately from request_manifest.json below
            (ds["DataSourceId"], ds["ElementId"], ds["DataSourceName"], ds["Units"], "unknown"),
        )

    return len(elements), len(datasources)


def ingest_datapoints_and_aggregation_types(cur, company_dir: Path):
    """
    Uses request_manifest.json as the source of truth for which file maps to
    which datasource_id and aggregation_type, rather than parsing filenames.
    """
    manifest = load_json(company_dir / "api" / "request_manifest.json")
    total_points = 0

    for entry in manifest:
        params = entry.get("params", {})
        if "dataSourceIds" not in params:
            continue  # skip Plant/Element/Datasource list entries, only want DataList_v2 entries

        ds_id = int(params["dataSourceIds"])
        aggregation_type = params["aggregationType"]
        file_path = company_dir / entry["file"]

        # backfill the real aggregation_type now that we know it
        cur.execute(
            "UPDATE datasources SET aggregation_type = %s WHERE id = %s",
            (aggregation_type, ds_id),
        )

        points = load_json(file_path)
        rows = [
            (ds_id, datetime.fromisoformat(p["Date"].replace("Z", "+00:00")), p["Value"])
            for p in points
        ]
        execute_values(
            cur,
            "INSERT INTO datapoints (datasource_id, ts, value) VALUES %s",
            rows,
            page_size=1000,
        )
        total_points += len(rows)

    print(f"  datapoints: {total_points}")


def ingest_financial(cur, company_dir: Path):
    prices_path = company_dir / "financial" / "hourly_market_prices.csv"
    prices = load_csv_rows(prices_path)
    rows = [
        (r["company_id"], r["zone"], r["timestamp"], float(r["eur_per_mwh"]))
        for r in prices
    ]
    execute_values(
        cur,
        "INSERT INTO hourly_market_prices (company_id, zone, ts, eur_per_mwh) VALUES %s",
        rows,
        page_size=1000,
    )
    print(f"  hourly_market_prices: {len(rows)}")

    costs_path = company_dir / "financial" / "monthly_costs.csv"
    costs = load_csv_rows(costs_path)
    rows = [
        (
            r["company_id"], int(r["plant_id"]), int(r["year"]), int(r["month"]),
            r["category"], float(r["amount_eur"]), r.get("notes") or None,
        )
        for r in costs
    ]
    execute_values(
        cur,
        "INSERT INTO monthly_costs (company_id, plant_id, year, month, category, amount_eur, notes) VALUES %s",
        rows,
        page_size=1000,
    )
    print(f"  monthly_costs: {len(rows)}")


# ---------- main ----------

def main():
    if not DATA_DIR.exists():
        print(f"ERROR: data folder not found at {DATA_DIR}")
        sys.exit(1)

    company_dirs = sorted(p for p in DATA_DIR.iterdir() if p.is_dir())
    if not company_dirs:
        print(f"ERROR: no company folders found inside {DATA_DIR}")
        sys.exit(1)

    conn = get_connection()
    conn.autocommit = False
    cur = conn.cursor()

    try:
        for company_dir in company_dirs:
            print(f"\n=== {company_dir.name} ===")
            company_id = ingest_company(cur, company_dir)
            ingest_users(cur, company_dir, company_id)
            plant_ids = ingest_plants(cur, company_dir, company_id)

            for plant_id in plant_ids:
                n_el, n_ds = ingest_elements_and_datasources(cur, company_dir, plant_id)
                print(f"  plant {plant_id}: {n_el} elements, {n_ds} datasources")

            ingest_datapoints_and_aggregation_types(cur, company_dir)
            ingest_financial(cur, company_dir)

        conn.commit()
        print("\nIngestion complete. All changes committed.")
    except Exception as e:
        conn.rollback()
        print(f"\nERROR during ingestion, rolled back all changes: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()