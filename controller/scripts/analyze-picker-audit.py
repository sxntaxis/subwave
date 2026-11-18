#!/usr/bin/env python3
"""Offline, ID-redacting summary of private picker-offer JSONL."""
import argparse
import csv
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


DAYPARTS = ((5, 11, "morning"), (11, 16, "afternoon"), (16, 21, "evening"))


def daypart(iso, zone):
    at = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(zone)
    for start, end, name in DAYPARTS:
        if start <= at.hour < end:
            return name
    return "overnight"


def read_assignments(path):
    assignments = {}
    with open(path, newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            track_id = row.get("track_id", "").strip()
            library = row.get("library", "").strip()
            group = row.get("group", "").strip()
            if not track_id or library not in ("Personal", "Radar") or not group:
                raise ValueError("assignments must have track_id, library (Personal/Radar), and group columns")
            value = (library, group)
            if track_id in assignments and assignments[track_id] != value:
                raise ValueError("assignment file contains conflicting rows")
            assignments[track_id] = value
    if not assignments:
        raise ValueError("assignment file is empty")
    return assignments


def read_events(paths):
    events = []
    for path in paths:
        with open(path, encoding="utf-8") as stream:
            for line_no, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                event = json.loads(line)
                if event.get("schema_version") != 1 or event.get("path") not in ("agent", "pool", "auto_refresh"):
                    continue
                if not isinstance(event.get("candidate_ids"), list):
                    continue
                event["_source_file"] = path.name
                event["_line"] = line_no
                events.append(event)
    return sorted(events, key=lambda item: item.get("timestamp", ""))


def summarize(events, database, assignments, zone, output, max_air_hours):
    catalogue = Counter(assignments.values())
    with sqlite3.connect(f"file:{Path(database).resolve()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        plays = [dict(row) for row in db.execute(
            "SELECT id, track_id, played_at, source, show_id FROM plays "
            "WHERE track_id IS NOT NULL AND track_id != '' ORDER BY played_at"
        )]

    # Keyed by observed show/path/daypart/source-library/frozen group. Counts
    # deliberately distinguish pick opportunities from playlist refreshes.
    counts = defaultdict(Counter)
    distinct_offered = defaultdict(set)
    chosen_events = []
    refresh_events = [e for e in events if e["path"] == "auto_refresh"]
    refresh_end = {
        id(event): (refresh_events[index + 1]["timestamp"] if index + 1 < len(refresh_events) else None)
        for index, event in enumerate(refresh_events)
    }

    for event in events:
        path = event["path"]
        show = event.get("show_id") or "unknown"
        slot = daypart(event["timestamp"], zone)
        unique_ids = list(dict.fromkeys(i for i in event["candidate_ids"] if isinstance(i, str) and i))
        event_groups = set()
        for track_id in unique_ids:
            assignment = assignments.get(track_id)
            if not assignment:
                continue
            library, group = assignment
            key = (show, path, slot, library, group)
            counts[key]["candidate_exposures"] += 1
            distinct_offered[key].add(track_id)
            event_groups.add(key)
        for key in event_groups:
            counts[key]["opportunity_events"] += 1
        chosen = event.get("chosen_id")
        if path != "auto_refresh" and isinstance(chosen, str) and chosen in unique_ids \
                and event.get("outcome") in ("success", "repaired", "repicked", "fallback"):
            assignment = assignments.get(chosen)
            if assignment:
                key = (show, path, slot, assignment[0], assignment[1])
                counts[key]["selected_events"] += 1
                chosen_events.append((event, chosen, key))

    unmatched_plays = {play["id"]: play for play in plays}
    air_window = timedelta(hours=max_air_hours)
    # Track-ID/time/show matching only: the play ledger has no attempt ID.
    # Consume each actual play at most once and keep the method explicitly approximate.
    for event, chosen, _key in chosen_events:
        start = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
        candidates = []
        for play_id, play in unmatched_plays.items():
            if play.get("source") != "ai" or play.get("track_id") != chosen:
                continue
            if event.get("show_id") and play.get("show_id") != event["show_id"]:
                continue
            try:
                played = datetime.fromisoformat(play["played_at"].replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if start <= played <= start + air_window:
                candidates.append((played, play_id, play))
        if candidates:
            _, play_id, play = min(candidates)
            del unmatched_plays[play_id]
            assignment = assignments[chosen]
            key = (play.get("show_id") or "unknown", event["path"], daypart(play["played_at"], zone), assignment[0], assignment[1])
            counts[key]["aired_matches_approx"] += 1

    # A playlist refresh is an accepted set, not an LLM offer. Count later auto
    # plays whose IDs occur in the last refresh set before the next refresh.
    for index, event in enumerate(refresh_events):
        start = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
        end_text = refresh_end[id(event)]
        end = datetime.fromisoformat(end_text.replace("Z", "+00:00")) if end_text else start + air_window
        ids = set(event["candidate_ids"])
        for play_id, play in list(unmatched_plays.items()):
            if play.get("source") != "auto" or play.get("track_id") not in ids:
                continue
            try:
                played = datetime.fromisoformat(play["played_at"].replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if not start <= played < end:
                continue
            del unmatched_plays[play_id]
            assignment = assignments.get(play["track_id"])
            if assignment:
                key = (play.get("show_id") or event.get("show_id") or "unknown", "auto_refresh",
                       daypart(play["played_at"], zone), assignment[0], assignment[1])
                counts[key]["aired_matches_approx"] += 1

    columns = [
        "show_id", "path", "daypart", "library", "group",
        "eligible_catalogue_tracks", "opportunity_events", "candidate_exposures",
        "distinct_offered_tracks", "selected_events", "aired_matches_approx",
        "air_correlation",
    ]
    with open(output, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        keys = set(counts)
        for (show, path, slot, library, group) in sorted(keys):
            c = counts[(show, path, slot, library, group)]
            writer.writerow({
                "show_id": show,
                "path": path,
                "daypart": slot,
                "library": library,
                "group": group,
                "eligible_catalogue_tracks": catalogue[(library, group)],
                "opportunity_events": c["opportunity_events"],
                "candidate_exposures": c["candidate_exposures"],
                "distinct_offered_tracks": len(distinct_offered[(show, path, slot, library, group)]),
                "selected_events": c["selected_events"] if path != "auto_refresh" else "",
                "aired_matches_approx": c["aired_matches_approx"],
                "air_correlation": "approx_track_id_time_show" if c["aired_matches_approx"] else "not_observed",
            })
    return len(events), len(plays), len(counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True, help="private offers-YYYY-MM-DD.jsonl file or directory")
    parser.add_argument("--library", required=True, help="read-only SubWave library.db")
    parser.add_argument("--assignments", required=True, help="frozen CSV: track_id,library,group")
    parser.add_argument("--timezone", default="America/Costa_Rica")
    parser.add_argument("--max-air-hours", type=float, default=6.0)
    parser.add_argument("--out", required=True, help="aggregate CSV output; contains no track IDs")
    args = parser.parse_args()
    audit = Path(args.audit)
    files = sorted(audit.glob("offers-*.jsonl")) if audit.is_dir() else [audit]
    assignments = read_assignments(args.assignments)
    events = read_events(files)
    totals = summarize(events, args.library, assignments, ZoneInfo(args.timezone),
                       args.out, args.max_air_hours)
    print(f"records={totals[0]} plays_scanned={totals[1]} aggregate_rows={totals[2]}")
    print("Auto-refresh candidate sets are not LLM offers; airing correlation is approximate.")


if __name__ == "__main__":
    main()
