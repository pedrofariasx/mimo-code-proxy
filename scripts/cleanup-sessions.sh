#!/usr/bin/env bash
set -euo pipefail

MIMO="$HOME/Documentos/YouTube/mimo/sandbox/bin/mimo"
HOURS="${1:-5}"
CUTOFF=$(( $(date +%s%3N) - (HOURS * 3600000) ))

# Get sessions from mimocode.db via mimo db (TSV format)
"$MIMO" db "SELECT id, time_updated FROM session WHERE time_updated < $CUTOFF ORDER BY time_updated ASC;" 2>/dev/null \
  | tail -n +2 \
  | while IFS=$'\t' read -r id updated; do
      [[ -z "$id" ]] && continue
      age_h=$(( ($(date +%s%3N) - updated) / 3600000 ))
      echo "  deleting $id (${age_h}h stale)"
      "$MIMO" session delete "$id" 2>/dev/null || echo "  [error] $id"
    done

echo "Done."
