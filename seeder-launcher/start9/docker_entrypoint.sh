#!/bin/sh
set -e

# StartOS mounts the persistence volume at /root (manifest main.mounts.main).
# Keep the seeder's state in a subdir so the duplicity backup (which mounts the
# same volume at /root/data) lines up exactly.
DATA_DIR=/root/data
mkdir -p "$DATA_DIR"

# Container adaptation (the base image bakes these too; explicit + self-documenting):
#   0.0.0.0        - StartOS reaches the dashboard over its own network, not loopback
#   no-auth        - the StartOS interface proxy already gates access
#   no-update-check- updates come from the StartOS marketplace, not the in-app checker
export SEEDER_HOST=0.0.0.0
export SEEDER_PORT=8731
export SEEDER_NO_AUTH=1
export SEEDER_NO_UPDATE_CHECK=1

printf "\n [i] Starting PearCal Seeder (data: %s) ...\n\n" "$DATA_DIR"

# Populate the StartOS Properties page. compat.properties renders
# /root/start9/stats.yaml; nothing wrote it, so that menu was empty. This poller
# rewrites it from the seeder's own /api/status. Backgrounded and non-fatal: if
# it dies the seeder keeps running and Properties just stops refreshing.
mkdir -p /root/start9
node /app/start9/write-stats.js &

# tini as PID 1 so the worklet's `bare` child is reaped and signals propagate.
exec tini -- node /app/host/index.js \
  --bare /app/bare --bundle /app/worklet/seed.bundle --data "$DATA_DIR"
