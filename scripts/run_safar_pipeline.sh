#!/usr/bin/env bash
# Run the full Safar / Masjidly ingest → enrich → targets → dashboards → optional Supabase sync.
# Usage:
#   ./scripts/run_safar_pipeline.sh
#   SAFAR_SKIP_INSTAGRAM=1 SAFAR_SKIP_EMAIL=1 ./scripts/run_safar_pipeline.sh
#   SAFAR_FAST_MODE=1 ./scripts/run_safar_pipeline.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  export PATH="$ROOT/.venv/bin:$PATH"
fi
exec python3 safar_daily_pipeline.py "$@"
