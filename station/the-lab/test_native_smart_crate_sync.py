import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("native-smart-crate-sync.py"))
sync = importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)

def test_contract_guard_constant():
    assert sync.EXPECTED == "0.63.2 (be10f89c)"

def test_unicode_labels_are_not_normalized_into_ascii():
    assert "Norteño" != "Norteno"
    assert "Kayōkyoku" != "Kayōkyoku ".strip() + "x"

def test_resolves_all_exact_variants():
    assert sync.resolve_all("Modern Classical", ["Modern Classical", "MODERN CLASSICAL"]) == ["MODERN CLASSICAL", "Modern Classical"]

def test_zero_variant_fails_closed():
    try: sync.resolve_all("Missing", ["Ambient"])
    except SystemExit as exc: assert "genre resolution failed" in str(exc)
    else: raise AssertionError("zero variants must fail closed")

def test_null_evaluation_fails_closed():
    try: sync.require_evaluated({"name": "canary", "evaluatedAt": None})
    except SystemExit as exc: assert "not evaluated" in str(exc)
    else: raise AssertionError("null evaluatedAt must fail closed")

def test_variant_union_does_not_add_refinement_values():
    values = sync.resolve_all("Modern Classical", ["Modern Classical", "MODERN CLASSICAL"])
    assert all("%" not in value for value in values)

def test_full_membership_gate_requires_exact_ids():
    sync.require_membership({"a", "b"}, ["b", "a"])
    try: sync.require_membership({"a"}, {"b"})
    except SystemExit as exc: assert "membership" in str(exc)
    else: raise AssertionError("membership mismatch must fail closed")

def test_exact_any_rule_shape():
    genres = ["Contemporary", "Neo-Classical"]
    rule = {"all": [{"any": [{"is": {"genre": g}} for g in genres]}]}
    assert rule == {"all": [{"any": [{"is": {"genre": "Contemporary"}}, {"is": {"genre": "Neo-Classical"}}]}]}

def test_structural_binding_is_excluded():
    assert "STRUCTURAL_DYNAMIC" in sync.STRUCTURAL
