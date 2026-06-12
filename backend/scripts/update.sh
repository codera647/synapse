#!/usr/bin/env bash
#
# One-command backend update for the GPU VM: pull latest code + restart the service.
#
# Usage (on the VM):
#   bash /opt/synapse/backend/scripts/update.sh
#
# Tip: add a shell alias so it's even shorter —
#   echo "alias synup='bash /opt/synapse/backend/scripts/update.sh'" >> ~/.bashrc && source ~/.bashrc
#   ...then just run:  synup
#
set -euo pipefail

REPO_DIR="${SYNAPSE_REPO_DIR:-/opt/synapse}"
SERVICE="${SYNAPSE_SERVICE:-synapse-backend}"
VENV="${SYNAPSE_VENV:-/opt/synapse/.venv}"

echo "==> Pulling latest code in ${REPO_DIR}"
cd "${REPO_DIR}"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

if [[ "${BEFORE}" == "${AFTER}" ]]; then
  echo "==> Already up to date (no new commits). Restarting anyway."
else
  echo "==> Updated ${BEFORE:0:7} -> ${AFTER:0:7}"
  # If backend dependencies changed, reinstall them.
  if git diff --name-only "${BEFORE}" "${AFTER}" | grep -qE '^backend/requirements'; then
    echo "==> requirements changed -> reinstalling base deps"
    "${VENV}/bin/pip" install -q -r backend/requirements-base.txt || true
    echo "    (GPU deps in requirements-gpu.txt are NOT auto-installed; run manually if they changed)"
  fi
fi

echo "==> Restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

echo "==> Waiting for backend to come up..."
sleep 4
if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
  echo "==> Backend healthy: $(curl -fsS http://127.0.0.1:8000/health)"
else
  echo "==> WARNING: backend not responding yet. Check logs:"
  echo "    sudo journalctl -u ${SERVICE} -e --no-pager"
fi
