#!/usr/bin/env python3
"""
Cleanup stale sessions from Kilo/MiMo databases.

Removes sessions not updated in > N hours (default: 5) from:
  - ~/.local/share/mimocode/mimocode.db  (mimo CLI)
  - ~/.local/share/kilo/kilo.db           (VS Code Kilo extension)

Usage:
  python3 cleanup-sessions.py              # dry-run (shows what would be deleted)
  python3 cleanup-sessions.py --apply      # actually delete
  python3 cleanup-sessions.py --hours 24   # change threshold
  python3 cleanup-sessions.py --vacuum     # also VACUUM after deletion
"""

import sqlite3
import time
import os
import argparse
import shutil

MIMO_DB = os.path.expanduser("~/.local/share/mimocode/mimocode.db")
KILO_DB = os.path.expanduser("~/.local/share/kilo/kilo.db")

# Tables that reference session_id and their count column for stats
MIMO_TABLES = [
    "actor_registry",
    "history_fts",
    "message",
    "part",
    "task",
    "task_event",
    "workflow_run",
]
KILO_TABLES = [
    "message",
    "part",
    "session_message",
    "todo",
]


def get_db_size(path):
    if not os.path.exists(path):
        return 0
    wal = path + "-wal"
    shm = path + "-shm"
    total = os.path.getsize(path)
    if os.path.exists(wal):
        total += os.path.getsize(wal)
    if os.path.exists(shm):
        total += os.path.getsize(shm)
    return total


def format_size(bytes_):
    for unit in ("B", "KB", "MB", "GB"):
        if bytes_ < 1024:
            return f"{bytes_:.1f}{unit}"
        bytes_ /= 1024
    return f"{bytes_:.1f}TB"


def connect_db(path, label):
    if not os.path.exists(path):
        print(f"  [!] Database not found: {path}")
        return None
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=OFF;")
    return conn


def get_stale_sessions(conn, threshold_ms):
    cur = conn.execute(
        "SELECT id, time_updated, time_created, title, project_id FROM session "
        "WHERE time_updated IS NOT NULL AND time_updated < ? "
        "ORDER BY time_updated ASC",
        (threshold_ms,),
    )
    return cur.fetchall()


def delete_session_data(conn, session_id, tables):
    for table in tables:
        conn.execute(f'DELETE FROM "{table}" WHERE session_id = ?', (session_id,))
    conn.execute("DELETE FROM session WHERE id = ?", (session_id,))


def cleanup_database(path, label, tables, hours, apply, vacuum):
    print(f"\n{'='*60}")
    print(f"Database: {label}")
    print(f"Path: {path}")
    print(f"{'='*60}")

    size_before = get_db_size(path)
    print(f"Size before: {format_size(size_before)}")

    conn = connect_db(path, label)
    if conn is None:
        return 0

    now_ms = int(time.time() * 1000)
    threshold_ms = now_ms - (hours * 3600 * 1000)

    stale = get_stale_sessions(conn, threshold_ms)
    if not stale:
        print("  No stale sessions found.")
        conn.close()
        return 0

    total_affected = {}
    print(f"\n  Found {len(stale)} stale sessions (not updated in >{hours}h):")
    print(f"  {'Session ID':<40} {'Age':>8} {'Title':<50}")
    print(f"  {'-'*40} {'-'*8} {'-'*50}")

    for s in stale:
        sid, updated, created, title, pid = s
        age_h = (now_ms - updated) / 3600000
        title_short = (title or "(no title)")[:48]
        print(f"  {sid:<40} {age_h:>7.1f}h {title_short:<50}")

    if not apply:
        # Dry-run: count what would be deleted
        print(f"\n  [DRY-RUN] Use --apply to delete. Counting related rows...")
        total = 0
        for table in tables:
            cur = conn.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE session_id IN ({",".join("?" for _ in stale)})',
                [s[0] for s in stale],
            )
            count = cur.fetchone()[0]
            if count > 0:
                total_affected[table] = count
                total += count
        total_affected["session"] = len(stale)
        total += len(stale)
        print(f"  Would delete approximately {total} rows across {len(total_affected)} tables.")
        for t, c in sorted(total_affected.items()):
            print(f"    {t}: {c}")
    else:
        print(f"\n  Deleting...")
        for s in stale:
            sid = s[0]
            delete_session_data(conn, sid, tables)
        print(f"  Deleted {len(stale)} sessions and related rows.")

        if vacuum:
            print("  Running VACUUM to reclaim space...")
            conn.execute("VACUUM;")
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")

    conn.commit()
    conn.close()

    if apply:
        size_after = get_db_size(path)
        print(f"  Size after:  {format_size(size_after)}")
        print(f"  Freed:       {format_size(size_before - size_after)}")

    return len(stale)


def main():
    parser = argparse.ArgumentParser(
        description="Cleanup stale sessions from Kilo/MiMo databases."
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=5,
        help="Delete sessions not updated in this many hours (default: 5)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually perform deletion (default: dry-run)",
    )
    parser.add_argument(
        "--vacuum",
        action="store_true",
        help="VACUUM after deletion to reclaim disk space",
    )
    parser.add_argument(
        "--kilo-only",
        action="store_true",
        help="Only cleanup kilo.db (VS Code extension)",
    )
    parser.add_argument(
        "--mimo-only",
        action="store_true",
        help="Only cleanup mimocode.db (mimo CLI)",
    )
    args = parser.parse_args()

    mode = "DRY-RUN" if not args.apply else "APPLY"
    print(f"=== Stale Session Cleanup ({mode}) ===")
    print(f"Threshold: >{args.hours}h since last update")
    if args.vacuum:
        print("VACUUM: enabled")

    total = 0

    if not args.kilo_only:
        total += cleanup_database(
            MIMO_DB, "mimocode.db (mimo CLI)", MIMO_TABLES,
            args.hours, args.apply, args.vacuum,
        )

    if not args.mimo_only:
        total += cleanup_database(
            KILO_DB, "kilo.db (VS Code Kilo)", KILO_TABLES,
            args.hours, args.apply, args.vacuum,
        )

    print(f"\n{'='*60}")
    if args.apply:
        print(f"Cleanup complete. Deleted {total} stale sessions.")
    else:
        print(f"Dry-run complete. {total} sessions would be deleted.")
        print(f"Run with --apply to perform deletion.")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
