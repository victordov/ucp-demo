#!/usr/bin/env bash
# Stop all UCP + AP2 suite servers (Shopping Agent, Merchant Portal,
# Credentials Provider, Payment Provider) by their ports.
set -u

PORTS=(4100 4101 4102 4103)
killed=0

for port in "${PORTS[@]}"; do
  # Find listeners on the port (macOS + Linux compatible).
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    # Fallback for systems without lsof
    pids=$(fuser "$port"/tcp 2>/dev/null || true)
  fi
  if [ -n "$pids" ]; then
    echo "Stopping port $port (pid: $pids)"
    kill $pids 2>/dev/null || true
    sleep 0.3
    # Force-kill anything still listening
    still=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$still" ] && kill -9 $still 2>/dev/null || true
    killed=$((killed + 1))
  else
    echo "Port $port: nothing running"
  fi
done

# Also clean up any stray dev runners (concurrently / tsx server processes).
pkill -f "tsx apps/.*/src/server.ts" 2>/dev/null && echo "Stopped stray tsx server processes" || true

echo "Done — stopped $killed service(s)."
