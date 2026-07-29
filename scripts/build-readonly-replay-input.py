#!/usr/bin/env python3
"""Build the DJ v2 exporter input from explicit 30-day replay tables only."""

import datetime as dt
import json
import os
import sqlite3
import sys


DB_PATH = os.environ.get("CROSSFADIO_REPLAY_DB")
NOW = dt.datetime.now(dt.timezone.utc)
CUTOFF = NOW - dt.timedelta(days=30)
MAX_SELECTION_RUNS = 500
MAX_POLICY_CASES = 2000
POLICY_CASE_QUERY_CHUNK_SIZE = 200


def epoch_ms(value):
    if value is None:
        return None
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


def json_array(value):
    parsed = json.loads(value or "[]")
    if not isinstance(parsed, list):
        raise ValueError("expected JSON array")
    return parsed


def json_object(value):
    parsed = json.loads(value or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("expected JSON object")
    return parsed


def rows(connection, sql, params=()):
    return [dict(row) for row in connection.execute(sql, params).fetchall()]


def require_tables(connection):
    required = {
        "listening_episodes",
        "selection_replay_runs",
        "selection_policy_replay_cases",
        "retrieval_attempts",
    }
    found = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)",
            tuple(sorted(required)),
        ).fetchall()
    }
    missing = sorted(required - found)
    if missing:
        raise RuntimeError("required replay tables missing: " + ",".join(missing))


def replay_run_key(row):
    return (row["userId"], row["runId"])


def select_run_prefix(
    selection_runs,
    max_runs=MAX_SELECTION_RUNS,
    max_cases=MAX_POLICY_CASES,
):
    selected = []
    selected_case_count = 0
    for run in selection_runs:
        if len(selected) >= max_runs or selected_case_count >= max_cases:
            break
        expected = run["candidateCount"]
        if selected_case_count + expected > max_cases:
            break
        selected.append(run)
        selected_case_count += expected
    return selected


def require_complete_policy_case_coverage(selection_runs, policy_case_counts):
    for run in selection_runs:
        key = replay_run_key(run)
        expected = run["candidateCount"]
        actual = policy_case_counts.get(key, 0)
        if actual != expected:
            raise RuntimeError(
                f"incomplete policy replay coverage for {key[0]}/{key[1]}: "
                f"expected {expected}, got {actual}"
            )


def select_complete_run_prefix(
    selection_runs,
    policy_case_counts,
    max_runs=MAX_SELECTION_RUNS,
    max_cases=MAX_POLICY_CASES,
):
    selected = select_run_prefix(selection_runs, max_runs, max_cases)
    require_complete_policy_case_coverage(selected, policy_case_counts)
    return selected


def selection_run_candidates(connection, cutoff, now):
    return rows(
        connection,
        """
        SELECT run_id AS runId, user_id AS userId, started_at AS startedAt,
               completed_at AS completedAt, selected_track_ids_json AS selectedTrackIds,
               candidate_count AS candidateCount, eligible_count AS eligibleCount,
               appended_count AS appendedCount, latency_ms AS latencyMs,
               hard_violation_count AS hardViolationCount,
               prompt_json_status AS promptJsonStatus, journey_published AS journeyPublished,
               narration_status AS narrationStatus,
               narration_deadline_at AS narrationDeadlineAt,
               outcome, reason_codes_json AS reasonCodes
        FROM selection_replay_runs
        WHERE julianday(started_at) >= julianday(?)
          AND julianday(started_at) <= julianday(?)
          AND completed_at IS NOT NULL
        ORDER BY started_at DESC, run_id DESC
        LIMIT ?
        """,
        (cutoff, now, MAX_SELECTION_RUNS + 1),
    )


def count_policy_cases(policy_cases):
    counts = {}
    for policy_case in policy_cases:
        key = replay_run_key(policy_case)
        counts[key] = counts.get(key, 0) + 1
    return counts


def policy_cases_for_runs(connection, selected_runs):
    if not selected_runs:
        return []

    selected_keys = [replay_run_key(run) for run in selected_runs]
    policy_cases = []
    for offset in range(0, len(selected_keys), POLICY_CASE_QUERY_CHUNK_SIZE):
        chunk = selected_keys[offset:offset + POLICY_CASE_QUERY_CHUNK_SIZE]
        predicate = " OR ".join("(user_id = ? AND run_id = ?)" for _ in chunk)
        params = tuple(value for key in chunk for value in key)
        policy_cases.extend(rows(
            connection,
            f"""
            SELECT id AS caseId, run_id AS runId, user_id AS userId,
                   candidate_id AS candidateId, candidate_track_key AS candidateTrackKey,
                   candidate_artist_key AS candidateArtistKey, mode,
                   identity_valid AS identityValid, source,
                   quality_signals_json AS qualitySignals,
                   title_motif_keys_json AS titleMotifKeys,
                   base_score AS baseScore, batch_index AS batchIndex,
                   batch_limit AS batchLimit, context_json AS context,
                   pressure_json AS pressure, expected_json AS expected
            FROM selection_policy_replay_cases
            WHERE {predicate}
            """,
            params,
        ))

    run_order = {key: index for index, key in enumerate(selected_keys)}
    policy_cases.sort(key=lambda row: (
        run_order[replay_run_key(row)],
        row["batchIndex"],
        row["caseId"],
    ))
    return policy_cases


def main():
    if not DB_PATH:
        raise RuntimeError("CROSSFADIO_REPLAY_DB must point to the replay database")
    uri = "file:" + os.path.abspath(DB_PATH) + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    # Pin every SELECT below to one SQLite read snapshot. Selection runs and
    # their policy cases are committed separately while a live run progresses.
    connection.execute("BEGIN")
    require_tables(connection)
    cutoff = CUTOFF.isoformat().replace("+00:00", "Z")
    now = NOW.isoformat().replace("+00:00", "Z")

    episodes = rows(
        connection,
        """
        SELECT id AS episodeId, user_id AS userId, track_id AS trackId,
               started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs,
               position_ms AS positionMs, listened_ms AS listenedMs,
               outcome, protocol_version AS protocolVersion
        FROM listening_episodes
        WHERE julianday(started_at) >= julianday(?)
          AND julianday(started_at) <= julianday(?)
          AND outcome IS NOT NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1000
        """,
        (cutoff, now),
    )
    for row in episodes:
        row["startedAt"] = epoch_ms(row["startedAt"])
        if row["endedAt"] is None:
            row.pop("endedAt")
        else:
            row["endedAt"] = epoch_ms(row["endedAt"])
        if row["durationMs"] is None:
            row.pop("durationMs")

    selection_runs = select_run_prefix(selection_run_candidates(connection, cutoff, now))
    policy_cases = policy_cases_for_runs(connection, selection_runs)
    require_complete_policy_case_coverage(selection_runs, count_policy_cases(policy_cases))
    for row in selection_runs:
        row["startedAt"] = epoch_ms(row["startedAt"])
        row["completedAt"] = epoch_ms(row["completedAt"])
        if row["narrationDeadlineAt"] is None:
            row.pop("narrationDeadlineAt")
        else:
            deadline = epoch_ms(row["narrationDeadlineAt"])
            row["narrationDeadlineAt"] = deadline
            if row["narrationStatus"] == "pending" and deadline <= int(NOW.timestamp() * 1000):
                row["narrationStatus"] = "failed"
        row["selectedTrackIds"] = json_array(row["selectedTrackIds"])
        row["reasonCodes"] = json_array(row["reasonCodes"])
        row["journeyPublished"] = bool(row["journeyPublished"])
        if row["outcome"] == "superseded":
            row["outcome"] = "empty"

    retrieval_attempts = rows(
        connection,
        """
        SELECT id AS attemptId, run_id AS runId, user_id AS userId, source,
               request_kind AS requestKind, normalized_query AS normalizedQuery,
               attempted_at AS attemptedAt, searched_count AS searchedCount,
               result_count AS resultCount, added_count AS addedCount,
               selected_count AS selectedCount
        FROM retrieval_attempts
        WHERE julianday(attempted_at) >= julianday(?)
          AND julianday(attempted_at) <= julianday(?)
        ORDER BY attempted_at DESC, id DESC
        LIMIT 1000
        """,
        (cutoff, now),
    )
    for row in retrieval_attempts:
        row["attemptedAt"] = epoch_ms(row["attemptedAt"])
        if row["runId"] is None:
            row.pop("runId")

    for row in policy_cases:
        row["qualitySignals"] = json_object(row["qualitySignals"])
        row["titleMotifKeys"] = json_array(row["titleMotifKeys"])
        row["context"] = json_object(row["context"])
        row["pressure"] = json_array(row["pressure"])
        row["expected"] = json_object(row["expected"])
        row["identityValid"] = bool(row["identityValid"])

    json.dump(
        {
            "episodes": episodes,
            "selectionRuns": selection_runs,
            "retrievalAttempts": retrieval_attempts,
            "policyCases": policy_cases,
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"replay input build failed: {error}\n")
        raise SystemExit(1)
