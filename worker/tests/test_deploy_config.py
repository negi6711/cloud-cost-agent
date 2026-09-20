"""The Render blueprint is executable configuration, so its mistakes are deployment incidents.

A blueprint sync re-applies every value the blueprint declares. A switch that an operator flips in
the dashboard must therefore be declared `sync: false`, or the next unrelated deploy silently puts
it back — which is how model-assisted classification switched itself off in staging once.
"""

from __future__ import annotations

from typing import Any

import pytest
import yaml

from cca.settings import REPO_ROOT

BLUEPRINT = REPO_ROOT / "render.yaml"

# Settings an operator turns on per environment, after verifying something by hand. Declaring a
# value for any of these makes the blueprint authoritative and the dashboard a lie.
DASHBOARD_CONTROLLED = {"JEV_ENABLED", "TYPESAFE_API_KEY"}


def env_vars() -> list[tuple[str, dict[str, Any]]]:
    blueprint = yaml.safe_load(BLUEPRINT.read_text(encoding="utf-8"))
    found: list[tuple[str, dict[str, Any]]] = []
    for group in blueprint.get("envVarGroups", []):
        found += [(f"group {group['name']}", var) for var in group.get("envVars", [])]
    for service in blueprint.get("services", []):
        found += [(f"service {service['name']}", var) for var in service.get("envVars", [])]
    return found


@pytest.mark.parametrize("key", sorted(DASHBOARD_CONTROLLED))
def test_dashboard_controlled_settings_are_never_given_a_value(key: str) -> None:
    declared = [(where, var) for where, var in env_vars() if var.get("key") == key]
    assert declared, f"{key} is no longer in render.yaml; update this test with it"
    for where, var in declared:
        assert "value" not in var, (
            f"{key} in {where} declares a value, so the next blueprint sync overwrites what the "
            "dashboard says. Use `sync: false`."
        )
        assert var.get("sync") is False, f"{key} in {where} must be `sync: false`"
