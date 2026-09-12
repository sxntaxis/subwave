import json
from collections import Counter
from pathlib import Path


BASE = Path(__file__).parent
SCHEDULE = json.loads((BASE / "THE-LAB-V6-R2-SCHEDULE.json").read_text(encoding="utf-8"))
UMBRELLAS = json.loads((BASE / "THE-LAB-V6-R2-UMBRELLAS.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((BASE / "show-manifest.json").read_text(encoding="utf-8"))
SHOWS = {show["id"]: show for show in MANIFEST["shows"]}
WEEK = SCHEDULE["schedule"]


EXPECTED_UMBRELLAS = {
    "u_nocturne": ("Nocturne", ["s_after_hours", "s_atmospheres", "s_movements", "s_absolute_cinema"]),
    "u_club": ("Club", ["s_signals", "s_housebrew", "s_ufos", "s_garageware", "s_hyperbeats"]),
    "u_neon": ("Neon", ["s_softsynth", "s_hallyu", "s_tokai_no_uta"]),
    "u_rock": ("Rock", ["s_hazey", "s_offbrand", "s_postwave", "s_distorted", "s_hellfire"]),
    "u_groove": ("Groove", ["s_afrodisiac", "s_funkplay", "s_lowkey", "s_lowriders", "s_hustlas", "s_skrrt"]),
    "u_latina": ("Latina", ["s_natural_mystic", "s_tropicalia", "s_tumbao", "s_parranda", "s_riddim", "s_chingoteo", "s_palenque"]),
    "u_jazz": ("Jazz", ["s_swingtime", "s_standards", "s_neobop"]),
    "u_americana": ("Americana", ["s_crossroads", "s_amplified", "s_folkside", "s_rustbound", "s_blue_suede"]),
}


def hours_by_show():
    return Counter(show_id for day in WEEK.values() for show_id in day)


def test_exact_umbrella_definitions_and_mapping():
    actual = {item["id"]: (item["name"], item["subshow_ids"]) for item in UMBRELLAS["umbrellas"]}
    assert actual == EXPECTED_UMBRELLAS
    assert UMBRELLAS["subshow_to_umbrella"] == {
        show_id: umbrella_id
        for umbrella_id, (_, show_ids) in EXPECTED_UMBRELLAS.items()
        for show_id in show_ids
    }


def test_freeform_is_station_flow_and_b_sides_is_unscheduled():
    assert "s_freeform" not in UMBRELLAS["subshow_to_umbrella"]
    assert UMBRELLAS["station_flow_show_ids"] == ["s_freeform"]
    assert UMBRELLAS["unscheduled_show_ids"] == ["s_b_sides"]
    assert hours_by_show()["s_freeform"] == 22
    assert hours_by_show()["s_b_sides"] == 0


def test_exact_weekly_coverage_has_no_gaps_or_overlaps():
    assert list(WEEK) == [str(day) for day in range(7)]
    assert all(len(slots) == 24 for slots in WEEK.values())
    assert sum(map(len, WEEK.values())) == 168


def test_schedule_references_existing_runtime_show_ids():
    assert all(show_id in SHOWS for day in WEEK.values() for show_id in day)


def test_expected_weekly_hours_for_every_scheduled_show():
    expected = {
        "s_absolute_cinema": 2, "s_after_hours": 10, "s_afrodisiac": 2, "s_amplified": 1,
        "s_atmospheres": 14, "s_blue_suede": 1, "s_chingoteo": 1, "s_crossroads": 1,
        "s_distorted": 3, "s_folkside": 4, "s_freeform": 22, "s_funkplay": 6,
        "s_garageware": 7, "s_hallyu": 1, "s_hazey": 8, "s_hellfire": 2,
        "s_housebrew": 9, "s_hustlas": 3, "s_hyperbeats": 3, "s_lowkey": 7,
        "s_lowriders": 4, "s_movements": 3, "s_neobop": 3, "s_natural_mystic": 3,
        "s_offbrand": 11, "s_palenque": 1, "s_parranda": 1, "s_postwave": 2,
        "s_riddim": 2, "s_rustbound": 1, "s_signals": 4, "s_skrrt": 1,
        "s_softsynth": 9, "s_standards": 2, "s_swingtime": 3, "s_tokai_no_uta": 3,
        "s_tropicalia": 4, "s_tumbao": 1, "s_ufos": 3,
    }
    assert dict(sorted(hours_by_show().items())) == dict(sorted(expected.items()))


def test_exact_unicode_round_trip():
    assert SHOWS["s_hallyu"]["name"] == "한류"
    assert SHOWS["s_tokai_no_uta"]["name"] == "都会の歌"
    assert "s_hallyu" in WEEK["5"] and "s_tokai_no_uta" in WEEK["3"] + WEEK["4"]


def test_weekend_shared_listening_is_fully_booked_without_b_sides():
    weekend = WEEK["5"] + WEEK["6"]
    assert len(weekend) == 48
    assert "s_b_sides" not in weekend
    assert all(show_id in SHOWS for show_id in weekend)


def test_umbrella_layer_cannot_change_repertoire_selection():
    assert all("genres" not in umbrella and "moods" not in umbrella for umbrella in UMBRELLAS["umbrellas"])
    assert all("crate" not in umbrella and "picker" not in umbrella for umbrella in UMBRELLAS["umbrellas"])
    assert all(show_id in SHOWS for show_id in UMBRELLAS["subshow_to_umbrella"])
