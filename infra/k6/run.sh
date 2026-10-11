#!/usr/bin/env bash
# Load test of edit fan-out across API instances (ADR 0004).
#
#   infra/k6/run.sh                       # 2 instances, 20 documents x 5 editors, 60 s
#   API_REPLICAS=1 infra/k6/run.sh        # the same against one instance, for comparison
#   DOCS=50 PER_DOC=4 DURATION=120 infra/k6/run.sh
#
# Starts the stack (docker compose --profile full) with rate limits off and a high per-user
# connection cap, since one test user opens every socket. Prints k6's summary (fan-out latency,
# messages), how many Redis PUBLISH commands carried the edits, and memory per instance.
set -euo pipefail
cd "$(dirname "$0")/.."

export API_REPLICAS="${API_REPLICAS:-2}" DOCS="${DOCS:-20}" PER_DOC="${PER_DOC:-5}"
export DURATION="${DURATION:-60}" EDIT_MS="${EDIT_MS:-500}"
export RATE_LIMIT_ENABLED=false COLLAB_MAX_CONNECTIONS_PER_USER=100000

compose() { docker compose -f docker-compose.yml --profile full "$@"; }
publishes() {
  compose exec -T redis redis-cli INFO commandstats |
    sed -n 's/^cmdstat_publish:calls=\([0-9]*\).*/\1/p' | tr -d '\r' | grep . || echo 0
}
memory() {
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' |
    grep -E 'collabedit-api-[0-9]+' | sort
}

compose up -d --build --wait >/dev/null 2>&1
echo "== $API_REPLICAS instance(s), $DOCS documents x $PER_DOC editors, one edit each per ${EDIT_MS} ms, ${DURATION} s"
echo "-- memory before:"
memory

before=$(publishes)
# Memory with every room open, halfway through.
(sleep $((DURATION / 2 + 10)) && echo "-- memory halfway:" && memory) &
sampler=$!
docker run --rm -i --network collabedit_default \
  -e DOCS -e PER_DOC -e DURATION -e EDIT_MS \
  grafana/k6:1.3.0 run --quiet - <k6/fanout.js
wait "$sampler" || true
after=$(publishes)
echo "-- Redis PUBLISH commands during the run: $((after - before))"
