"""
backend/extraction_bootstrap.py

Standalone launcher that spawns N extraction worker processes. This is mainly a
manual/debug utility — in normal operation the worker pool in worker_bootstrap.py
already runs extraction workers. Use this to run extra extraction capacity on its
own (e.g. a second host dedicated to text_extraction), optionally scoped to one
library via LIB_ID.

Run (from the backend/ directory):
  EXTRACT_WORKERS=3 python extraction_bootstrap.py
  LIB_ID=<uuid> EXTRACT_WORKERS=2 python extraction_bootstrap.py
"""

import os
import sys
import subprocess

WORKERS = int(os.getenv("EXTRACT_WORKERS", "3"))
LIB_ID = os.getenv("LIB_ID")  # optional: restrict to one library

procs = []
for i in range(1, WORKERS + 1):
    env = os.environ.copy()
    env["WORKER_ID"] = f"worker-{i}"
    if LIB_ID:
        env["LIB_ID"] = LIB_ID
    # Use the same interpreter that launched this script (venv-safe).
    procs.append(subprocess.Popen([sys.executable, "extraction_worker.py"], env=env))

try:
    for p in procs:
        p.wait()
except KeyboardInterrupt:
    for p in procs:
        p.terminate()
