#!/usr/bin/env bash
# Run the Synapse backend (FastAPI + worker pool).
#
# Modules use flat imports (e.g. `from hardware import ...`), so uvicorn must be
# launched from the backend/ directory as `app:app` (NOT `backend.app:app`).
set -euo pipefail

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"

# Resolve the backend directory (this script lives in backend/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${BACKEND_DIR}"

# Optionally source an env file (systemd usually provides env directly).
if [[ -n "${SYNAPSE_ENV_FILE:-}" && -f "${SYNAPSE_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${SYNAPSE_ENV_FILE}"
  set +a
fi

exec uvicorn app:app --host "${HOST}" --port "${PORT}"
