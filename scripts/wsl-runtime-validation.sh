#!/usr/bin/env bash

set -Eeuo pipefail

node_image='node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c'
compose_project='stay-fable-wsl-validation'
lock_container='stay-fable-wsl-validation-lock'
api_container='stay-fable-wsl-validation-api'
worker_container='stay-fable-wsl-validation-worker'
validation_root='/tmp/stay-fable-wsl-validation'
expected_validation_root="$validation_root"
compose_started=false
validation_root_owned=false
lock_owned=false

if [ -z "${VALIDATION_TOKEN:-}" ] || [ -z "${REPO_ROOT:-}" ]; then
  echo 'VALIDATION_TOKEN and REPO_ROOT are required' >&2
  exit 1
fi
if [ -n "${STABLE_GATE_OWNER_TOKEN:-}" ]; then
  if [ "$VALIDATION_TOKEN" != "$STABLE_GATE_OWNER_TOKEN" ] ||
    ! printf '%s' "$VALIDATION_TOKEN" | grep -Eq '^[[:xdigit:]]{32}$'; then
    echo 'Gated validation token does not match its owner' >&2
    exit 1
  fi
  compose_project="${compose_project}-${VALIDATION_TOKEN}"
  lock_container="${lock_container}-${VALIDATION_TOKEN}"
  api_container="${api_container}-${VALIDATION_TOKEN}"
  worker_container="${worker_container}-${VALIDATION_TOKEN}"
  validation_root="${validation_root}-${VALIDATION_TOKEN}"
  expected_validation_root="$validation_root"
fi
ownership_marker="$validation_root/.stay-fable-validation-owner"

repo_root="$(cd -- "$REPO_ROOT" && pwd -P)"
if [ "${CLEANUP_ONLY:-false}" != true ]; then
  if [ -z "${ARTIFACT_ROOT:-}" ]; then
    echo 'ARTIFACT_ROOT is required for validation' >&2
    exit 1
  fi
  artifact_root="$(cd -- "$ARTIFACT_ROOT" && pwd -P)"
  if [ "$artifact_root" != "$repo_root/.wsl-runtime" ]; then
    echo 'Artifact root is not owned by the current linked worktree' >&2
    exit 1
  fi
fi

runtime_marker() {
  local marker="$1"
  if [ -n "${STABLE_GATE_OWNER_TOKEN:-}" ]; then
    printf '%s OWNER=%s\n' "$marker" "$STABLE_GATE_OWNER_TOKEN"
  else
    printf '%s\n' "$marker"
  fi
}

cleanup_validation() {
  local exit_status="$1"
  local cleanup_failed=0
  local name token remaining_containers remaining_project_containers remaining_networks
  trap - EXIT

  if [ "$lock_owned" = true ]; then
    token="$(docker inspect --format '{{ index .Config.Labels "stay-fable.validation-token" }}' "$lock_container" 2>/dev/null || true)"
    if [ "$token" != "$VALIDATION_TOKEN" ]; then
      echo "Ownership label mismatch; refusing cleanup for $lock_container" >&2
      return 1
    fi
  fi

  for name in "$api_container" "$worker_container"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      token="$(docker inspect --format '{{ index .Config.Labels "stay-fable.validation-token" }}' "$name" 2>/dev/null || true)"
      if [ "$token" != "$VALIDATION_TOKEN" ]; then
        echo "Ownership label mismatch; refusing to remove $name" >&2
        cleanup_failed=1
      elif ! docker rm -f "$name" >/dev/null; then
        cleanup_failed=1
      fi
    fi
  done

  if [ "$compose_started" = true ]; then
    token="$(docker inspect --format '{{ index .Config.Labels "stay-fable.validation-token" }}' "$lock_container" 2>/dev/null || true)"
    if [ "$token" != "$VALIDATION_TOKEN" ]; then
      echo "Ownership label mismatch; refusing Compose cleanup for $lock_container" >&2
      cleanup_failed=1
    elif ! POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose \
      --project-name "$compose_project" \
      -f "$repo_root/infrastructure/compose.yaml" down; then
      cleanup_failed=1
    fi
  fi

  if [ "$lock_owned" = true ]; then
    token="$(docker inspect --format '{{ index .Config.Labels "stay-fable.validation-token" }}' "$lock_container" 2>/dev/null || true)"
    if [ "$token" != "$VALIDATION_TOKEN" ]; then
      echo "Ownership label mismatch; refusing to remove $lock_container" >&2
      cleanup_failed=1
    elif ! docker rm "$lock_container" >/dev/null; then
      cleanup_failed=1
    fi
  fi

  if ! remaining_containers="$(docker ps -a \
    --filter "label=stay-fable.validation-token=$VALIDATION_TOKEN" \
    --format '{{.Names}}')"; then
    echo 'Unable to verify owner-labeled container cleanup' >&2
    cleanup_failed=1
  elif [ -n "$remaining_containers" ]; then
    echo 'Owner-labeled containers remain after cleanup' >&2
    cleanup_failed=1
  fi
  if ! remaining_project_containers="$(docker ps -a \
    --filter "label=com.docker.compose.project=$compose_project" \
    --format '{{.Names}}')" ||
    ! remaining_networks="$(docker network ls \
      --filter "label=com.docker.compose.project=$compose_project" \
      --format '{{.Name}}')"; then
    echo 'Unable to verify owner Compose cleanup' >&2
    cleanup_failed=1
  elif [ -n "$remaining_project_containers" ] ||
    [ -n "$remaining_networks" ]; then
    echo 'Owner Compose resources remain after cleanup' >&2
    cleanup_failed=1
  fi

  if [ "$validation_root_owned" = true ]; then
    if [ "$validation_root" != "$expected_validation_root" ] ||
      [ ! -f "$ownership_marker" ] ||
      [ "$(cat -- "$ownership_marker")" != "$VALIDATION_TOKEN" ]; then
      echo 'Runtime directory ownership check failed; refusing cleanup' >&2
      cleanup_failed=1
    elif ! rm -rf -- "$validation_root"; then
      cleanup_failed=1
    fi
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    return 1
  fi
  runtime_marker 'SLICE2_RUNTIME_CLEANUP_COMPLETE'
  return "$exit_status"
}

if [ "${CLEANUP_ONLY:-false}" = true ]; then
  if docker container inspect "$lock_container" >/dev/null 2>&1; then
    lock_token="$(docker inspect --format '{{ index .Config.Labels "stay-fable.validation-token" }}' "$lock_container" 2>/dev/null || true)"
    if [ "$lock_token" != "$VALIDATION_TOKEN" ]; then
      echo "Ownership label mismatch; refusing cleanup for $lock_container" >&2
      exit 1
    fi
    compose_started=true
    lock_owned=true
    if [ -e "$validation_root" ]; then
      validation_root_owned=true
    fi
    cleanup_validation 0
    exit $?
  fi
  echo 'Owner lock is absent; cleanup remains unconfirmed' >&2
  exit 1
fi

trap 'cleanup_validation $?' EXIT

docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

for name in "$api_container" "$worker_container"; do
  if [ -n "$(docker ps -a --filter "name=^/${name}$" --format '{{.Names}}')" ]; then
    echo "Validation container already exists; refusing takeover: $name" >&2
    exit 1
  fi
done
if [ -n "$(docker ps -a --filter "name=^/${lock_container}$" --format '{{.Names}}')" ]; then
  echo "Validation lock already exists; another validation may be running: $lock_container" >&2
  exit 1
fi
if [ -n "$(docker ps -a --filter "label=com.docker.compose.project=$compose_project" --format '{{.Names}}')" ]; then
  echo 'Validation Compose project already has containers; refusing takeover' >&2
  exit 1
fi
if [ -n "$(docker network ls --filter "label=com.docker.compose.project=$compose_project" --format '{{.Name}}')" ]; then
  echo 'Validation Compose project already has a network; refusing takeover' >&2
  exit 1
fi
if [ -e "$validation_root" ]; then
  echo 'Validation runtime directory already exists; refusing takeover' >&2
  exit 1
fi

if ! docker create --name "$lock_container" \
  --label "stay-fable.validation-token=$VALIDATION_TOKEN" \
  "$node_image" true >/dev/null; then
  echo 'Unable to acquire the atomic validation lock' >&2
  exit 1
fi
lock_owned=true

mkdir -- "$validation_root"
printf '%s\n' "$VALIDATION_TOKEN" >"$ownership_marker"
validation_root_owned=true
for runtime_name in api worker; do
  mkdir -- "$validation_root/$runtime_name"
  cp -a -- "$artifact_root/$runtime_name/." "$validation_root/$runtime_name/"
done

for required_path in \
  "$validation_root/api/dist/main.js" \
  "$validation_root/worker/dist/main.js"; do
  if [ ! -e "$required_path" ]; then
    echo "Required runtime artifact is missing: $required_path" >&2
    exit 1
  fi
done

compose_started=true
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose \
  --project-name "$compose_project" \
  -f "$repo_root/infrastructure/compose.yaml" \
  up -d --wait --wait-timeout 120

pwsh_path="$(command -v pwsh.exe)"
repo_windows="$(wslpath -w "$repo_root")"
bootstrap_windows="$(wslpath -w "$repo_root/scripts/wsl-database-bootstrap.ps1")"
"$pwsh_path" -NoProfile -File "$bootstrap_windows" -RepoRoot "$repo_windows" -Port 55432

database_url='postgresql://stay_fable:local_only_password@postgres:5432/stay_fable?schema=public&sslmode=disable'

docker run -d --name "$api_container" \
  --network "${compose_project}_default" \
  --label "stay-fable.validation-token=$VALIDATION_TOKEN" \
  --user node --read-only --tmpfs /tmp \
  --workdir /app \
  -v "$validation_root/api:/app:ro" \
  -v "$repo_root/scripts/verify-slice-3-runtime.mjs:/verify-slice-3-runtime.mjs:ro" \
  -v "$repo_root/scripts/verify-slice-4-runtime.mjs:/verify-slice-4-runtime.mjs:ro" \
  -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=development \
  -e PORT=3000 \
  -e "DATABASE_URL=$database_url" \
  -e REDIS_URL=redis://redis:6379 \
  -e IDENTITY_PROVIDER=mock \
  -e ENABLE_MOCK_PAYMENT=true \
  -e SESSION_ACCESS_TTL_SECONDS=7200 \
  -e SESSION_REFRESH_TTL_SECONDS=2592000 \
  -e LOCATION_MAX_DISTANCE_METERS=100000 \
  "$node_image" node dist/main.js

docker run -d --name "$worker_container" \
  --network "${compose_project}_default" \
  --label "stay-fable.validation-token=$VALIDATION_TOKEN" \
  --user node --read-only --tmpfs /tmp \
  --workdir /app \
  -v "$validation_root/worker:/app:ro" \
  -e NODE_ENV=development \
  -e "DATABASE_URL=$database_url" \
  -e REDIS_URL=redis://redis:6379 \
  -e BOOKING_EXPIRY_POLL_MS=1000 \
  "$node_image" node dist/main.js

api_ready=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    http://127.0.0.1:3000/health/ready >/dev/null; then
    api_ready=true
    break
  fi
  sleep 1
done
if [ "$api_ready" != true ]; then
  echo 'API did not become ready within the bounded readiness window' >&2
  docker logs "$api_container" >&2 || true
  docker logs "$worker_container" >&2 || true
  exit 1
fi

POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose \
  --project-name "$compose_project" \
  -f "$repo_root/infrastructure/compose.yaml" \
  exec -T postgres psql -U stay_fable -d stay_fable -c 'SELECT PostGIS_Version();'
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose \
  --project-name "$compose_project" \
  -f "$repo_root/infrastructure/compose.yaml" \
  exec -T redis redis-cli ping
curl --fail --silent --show-error -o /dev/null -w '/health/live HTTP %{http_code}\n' \
  http://127.0.0.1:3000/health/live
curl --fail --silent --show-error -o /dev/null -w '/health/ready HTTP %{http_code}\n' \
  http://127.0.0.1:3000/health/ready
docker inspect --format 'name={{.Name}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}' \
  "$api_container" "$worker_container"

docker run --rm \
  --network "${compose_project}_default" \
  --user node --read-only --tmpfs /tmp \
  -v "$repo_root/scripts/verify-slice-1-runtime.mjs:/verify-slice-1-runtime.mjs:ro" \
  -e "API_BASE_URL=http://${api_container}:3000" \
  "$node_image" node /verify-slice-1-runtime.mjs

docker run --rm \
  --network "${compose_project}_default" \
  --user node --read-only --tmpfs /tmp \
  -v "$repo_root/scripts/verify-slice-2-runtime.mjs:/verify-slice-2-runtime.mjs:ro" \
  -e "API_BASE_URL=http://${api_container}:3000" \
  "$node_image" node /verify-slice-2-runtime.mjs

run_slice_three_runtime_validation() {
  local slice3_api_container="$1"
  local slice3_worker_container="$2"
  local slice3_database_url="$3"
  local runtime_exit=0

  docker exec \
    --user node \
    -e "API_BASE_URL=http://127.0.0.1:3000" \
    -e "DATABASE_URL=$slice3_database_url" \
    "$slice3_api_container" \
    node /verify-slice-3-runtime.mjs || runtime_exit=$?
  if [ "$runtime_exit" -eq 0 ]; then
    return 0
  fi

  echo 'SLICE3_RUNTIME_DIAGNOSTICS' >&2
  docker inspect \
    --format 'name={{.Name}} status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' \
    "$slice3_api_container" "$slice3_worker_container" >&2 || true
  docker logs --tail 200 "$slice3_api_container" >&2 || true
  docker logs --tail 200 "$slice3_worker_container" >&2 || true
  return "$runtime_exit"
}

run_slice_three_runtime_validation "$api_container" "$worker_container" "$database_url"

redact_slice_four_diagnostics() {
  sed -E \
    -e 's/[[:xdigit:]]{8}-[[:xdigit:]]{4}-[1-5][[:xdigit:]]{3}-[89abAB][[:xdigit:]]{3}-[[:xdigit:]]{12}/[REDACTED_UUID]/g' \
    -e 's/(\"(authorization|access[_-]token|refresh[_-]token|idempotency[_-]key|token)\"[[:space:]]*:[[:space:]]*\")[^\"]*/\1[REDACTED_SECRET]/Ig' \
    -e 's/(Key \(booking_id, idempotency_key\)=\(\[REDACTED_UUID\],[[:space:]]*)[^)]+/\1[REDACTED_SECRET]/Ig' \
    -e 's/((authorization|access[_-]token|refresh[_-]token|idempotency[_-]key|token)[=:][[:space:]]*)(Bearer[[:space:]]+)?[^,[:space:]]+/\1[REDACTED_SECRET]/Ig'
}

run_slice_four_runtime_validation() {
  local slice4_api_container="$1"
  local slice4_worker_container="$2"
  local slice4_database_url="$3"
  local runtime_exit=0

  docker exec \
    --user node \
    -e "API_BASE_URL=http://127.0.0.1:3000" \
    -e "DATABASE_URL=$slice4_database_url" \
    "$slice4_api_container" \
    node /verify-slice-4-runtime.mjs || runtime_exit=$?
  if [ "$runtime_exit" -eq 0 ]; then
    return 0
  fi

  echo 'SLICE4_RUNTIME_DIAGNOSTICS' >&2
  docker inspect \
    --format 'name={{.Name}} status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' \
    "$slice4_api_container" "$slice4_worker_container" 2>&1 |
    redact_slice_four_diagnostics >&2 || true
  docker logs --tail 200 "$slice4_api_container" 2>&1 |
    redact_slice_four_diagnostics >&2 || true
  docker logs --tail 200 "$slice4_worker_container" 2>&1 |
    redact_slice_four_diagnostics >&2 || true
  return "$runtime_exit"
}

run_slice_four_runtime_validation "$api_container" "$worker_container" "$database_url"

if [ -n "${STABLE_GATE_PATH:-}" ]; then
  runtime_marker 'SLICE4_UAT_READY http://127.0.0.1:3000'
fi

await_stable_window_gate() {
  if [ -z "${STABLE_GATE_PATH:-}" ]; then
    return 0
  fi
  if [ -z "${STABLE_GATE_OWNER_TOKEN:-}" ] ||
    ! printf '%s' "$STABLE_GATE_OWNER_TOKEN" | grep -Eq '^[[:xdigit:]]{32}$' ||
    [ "${STABLE_GATE_PATH#/}" = "$STABLE_GATE_PATH" ]; then
    echo 'Stable-window gate configuration is invalid' >&2
    return 1
  fi

  local gate_decision
  local timeout_seconds="${STABLE_GATE_TIMEOUT_SECONDS:-3600}"
  local waited_seconds=0
  if ! printf '%s' "$timeout_seconds" | grep -Eq '^[1-9][0-9]{0,4}$' ||
    [ "$timeout_seconds" -gt 86400 ]; then
    echo 'Stable-window gate timeout is invalid' >&2
    return 1
  fi
  while true; do
    if [ -f "$STABLE_GATE_PATH" ]; then
      IFS= read -r gate_decision <"$STABLE_GATE_PATH"
      case "$gate_decision" in
        "$STABLE_GATE_OWNER_TOKEN START")
          return 0
          ;;
        "$STABLE_GATE_OWNER_TOKEN ABORT")
          return 125
          ;;
        *)
          echo 'Stable-window gate decision is invalid' >&2
          return 1
          ;;
      esac
    fi
    if [ "$waited_seconds" -ge "$timeout_seconds" ]; then
      echo 'Stable-window gate wait timed out' >&2
      return 124
    fi
    sleep 1
    waited_seconds=$((waited_seconds + 1))
  done
}

worker_failure_pattern='("level" *: *(50|60)([,} ])|"level" *: *"(error|fatal)"|(^| )FATAL( |:)|uncaught *(exception)?|unhandled *(rejection)?|ECONN[A-Z_]*|reconnect(ion)? +loop)'
observe_worker_stability() {
  local observed_worker_container="$1"
  local minute worker_running restart_count worker_logs
  for minute in $(seq 1 10); do
    sleep 60
    worker_running="$(docker inspect --format '{{.State.Running}}' "$observed_worker_container")"
    restart_count="$(docker inspect --format '{{.RestartCount}}' "$observed_worker_container")"
    echo "Worker observation minute ${minute}/10 Running=${worker_running} RestartCount=${restart_count}"
    if [ "$worker_running" != true ] || [ "$restart_count" -ne 0 ]; then
      echo 'Worker stopped or restarted during observation' >&2
      return 1
    fi
    worker_logs="$(docker logs --since 65s "$observed_worker_container" 2>&1)"
    if printf '%s\n' "$worker_logs" | grep -Eiq "$worker_failure_pattern"; then
      echo 'Worker logs contain a fatal, connection, or reconnect-loop signal' >&2
      return 1
    fi
  done
}

echo 'SLICE2_RUNTIME_READY http://127.0.0.1:3000'

await_stable_window_gate
observe_worker_stability "$worker_container"

runtime_marker 'SLICE2_RUNTIME_STABLE_10_MINUTES'
cleanup_validation 0
trap - EXIT
