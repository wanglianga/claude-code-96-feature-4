#!/bin/sh
set -e

# 等待 MariaDB 就绪（compose healthcheck 之外再兜底一次）
if [ -n "$WAIT_DB_HOST" ]; then
  echo "[entrypoint] waiting for database ${WAIT_DB_HOST}:${WAIT_DB_PORT:-3306} ..."
  python - "$WAIT_DB_HOST" "${WAIT_DB_PORT:-3306}" <<'PY'
import socket, sys, time
host, port = sys.argv[1], int(sys.argv[2])
for i in range(60):
    try:
        with socket.create_connection((host, port), timeout=2):
            print(f"[entrypoint] database {host}:{port} is up")
            sys.exit(0)
    except OSError:
        time.sleep(1)
sys.exit(f"[entrypoint] database {host}:{port} not reachable")
PY
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
