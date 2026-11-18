# Private picker exposure audit

Gate 2 is passive observability only. It does not make picks, query the library,
change selection, modify play history, or call an LLM. The code is opt-in; normal
installations leave `SUBWAVE_PICKER_AUDIT` unset.

When explicitly enabled for the bounded observation window, candidate records
are written only to `/run/subwave-picker-audit/offers-YYYY-MM-DD.jsonl` in the
controller. Production supplies that path as an owner-only host bind mount
(directory mode `0700`; files `0600`), separate from state, backups, event logs,
and web/API mounts. The writer checks directory/file ownership and permissions,
uses a serialized best-effort append queue, drops on a queue overflow, caps each
daily file at 16 MiB, and prunes beyond seven calendar days. A logging failure
only emits a generic warning and never reaches selection.

Records contain the UTC time, trace correlation ID when available, selector
path, show ID, candidate IDs, chosen ID, bounded outcome/fallback labels, and
agent tool-call count. No prompts, responses, personal details, listener
identifiers, or audio metadata are recorded. Auto-refresh records represent
the final accepted playlist set, not a one-track model offer. Agent and pool
records for one track event share the existing trace ID and must be treated as
one correlated pick when calculating totals.

Disable collection immediately by recreating **only** the controller without
the private audit Compose override. The instrumented image then remains
installed with the flag unset and does no audit file I/O. Exact pre-deploy image
rollback is a separate operator procedure captured in the protected deployment
snapshot; never restore the entire settings snapshot just to disable auditing.

## Offline summary

The analysis script accepts the private JSONL, the existing SubWave
`library.db`, and the already-frozen Personal-first assignment CSV. The CSV must
contain `track_id,library,group`, with `library` equal to `Personal` or `Radar`.
It does not generate/reassign acoustic groups, and its aggregate output contains
no track IDs:

```sh
python3 controller/scripts/analyze-picker-audit.py \
  --audit /path/to/private-audit-directory \
  --library /path/to/library.db \
  --assignments /path/to/frozen-assignments.csv \
  --timezone America/Costa_Rica \
  --out ./picker-exposure-summary.csv
```

`eligible_catalogue_tracks` is the frozen catalogue baseline, not a claim that
every track was eligible under every show's filters. `agent` and `pool` offers
are counted per pick attempt; `auto_refresh` uses refresh/candidate-appearance
denominators and has no selected-event count. Airing matches use existing play
rows and track ID/show/time only, consume each play once, and are explicitly
approximate because the play ledger has no picker-attempt ID. Interpret results
with the existing schedule and daypart context; no programming or picker change
is authorized by these measurements.
