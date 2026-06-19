"""
The most important test file in this project. Proves, programmatically,
that the isolation guarantees described in app/db/migrations/001_schema.sql
and the project README actually hold — not just that they're claimed.

Run with:
    pytest tests/test_isolation.py -v

Requires DATABASE_URL in your environment / .env, pointing at the SAME
database the app uses (i.e. already migrated and ingested).

These tests connect exactly the way the application does — through
app.db.session.get_scoped_connection, the non-superuser app_user role, with
RLS session variables set per "request" — NOT through any privileged
shortcut. If these tests pass, the isolation is real at the database layer,
which is what the assignment specifically requires.
"""

import pytest

from app.db.session import get_scoped_connection


COMPANY_1_ADMIN = ("company_1", "energy+financial", "company_1_admin")
COMPANY_1_OPERATOR = ("company_1", "energy", "company_1_operator")
COMPANY_2_ADMIN = ("company_2", "energy+financial", "company_2_admin")


def _query(company_id, access_scope, user_id, sql):
    with get_scoped_connection(company_id, access_scope, user_id) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            return cur.fetchall()


class TestCompanyIsolation:
    """
    Core requirement: "A user from one company must not be able to access
    another company's data." Verified directly against the plants table,
    which has no row in common between companies.
    """

    def test_company_1_sees_only_its_own_plants(self):
        rows = _query(*COMPANY_1_ADMIN, "SELECT id FROM plants")
        plant_ids = {r[0] for r in rows}
        assert plant_ids == {1001, 1002}

    def test_company_2_sees_only_its_own_plants(self):
        rows = _query(*COMPANY_2_ADMIN, "SELECT id FROM plants")
        plant_ids = {r[0] for r in rows}
        assert plant_ids == {2001, 2002}

    def test_unscoped_query_cannot_see_other_companys_plants(self):
        """
        The actual adversarial case from the assignment brief: even a query
        with NO WHERE clause at all must not return another company's rows.
        This is the test that would fail if isolation were implemented at
        the application/prompt layer instead of the database layer.
        """
        rows = _query(*COMPANY_1_ADMIN, "SELECT id FROM plants")
        plant_ids = {r[0] for r in rows}
        assert 2001 not in plant_ids
        assert 2002 not in plant_ids

    def test_elements_are_isolated_via_plant_join_chain(self):
        rows = _query(*COMPANY_1_ADMIN, "SELECT plant_id FROM elements")
        plant_ids = {r[0] for r in rows}
        assert plant_ids == {1001, 1002}

    def test_datapoints_are_isolated_via_full_join_chain(self):
        """
        datapoints has no direct company_id column — isolation here depends
        entirely on the join chain datapoints -> datasources -> elements ->
        plants working correctly. This is the deepest, most indirect case.
        """
        rows = _query(
            *COMPANY_1_ADMIN,
            """
            SELECT DISTINCT p.company_id
            FROM datapoints dp
            JOIN datasources ds ON ds.id = dp.datasource_id
            JOIN elements e ON e.id = ds.element_id
            JOIN plants p ON p.id = e.plant_id
            """,
        )
        companies_visible = {r[0] for r in rows}
        assert companies_visible == {"company_1"}


class TestRoleBasedAccess:
    """
    Core requirement: "one user can access energy data but not financial
    data." Verified against both financial tables for an energy-only user.
    """

    def test_energy_only_user_gets_zero_market_prices(self):
        rows = _query(*COMPANY_1_OPERATOR, "SELECT * FROM hourly_market_prices")
        assert rows == []

    def test_energy_only_user_gets_zero_monthly_costs(self):
        rows = _query(*COMPANY_1_OPERATOR, "SELECT * FROM monthly_costs")
        assert rows == []

    def test_full_access_user_gets_market_prices(self):
        rows = _query(*COMPANY_1_ADMIN, "SELECT * FROM hourly_market_prices")
        assert len(rows) > 0

    def test_full_access_user_gets_monthly_costs(self):
        rows = _query(*COMPANY_1_ADMIN, "SELECT * FROM monthly_costs")
        assert len(rows) > 0

    def test_energy_only_user_still_sees_plant_data(self):
        """Energy access should NOT block energy-domain tables."""
        rows = _query(*COMPANY_1_OPERATOR, "SELECT id FROM plants")
        assert len(rows) == 2


class TestFailSafeDefault:
    """
    If the session variables are somehow never set, the system must fail
    CLOSED (return nothing) rather than fail OPEN (return everything).
    """

    def test_missing_company_id_returns_no_rows(self):
        # Empty string company_id should match nothing, not be ignored.
        rows = _query("", "energy+financial", "nobody", "SELECT id FROM plants")
        assert rows == []