#!/usr/bin/env bash

set -Eeuo pipefail

node_image='node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c'
compose_project='stay-fable-demo'
api_container='stay-fable-demo-api'
worker_container='stay-fable-demo-worker'
owner_label='stay-fable.demo-owner'

action="${DEMO_ACTION:?DEMO_ACTION is required}"
owner_token="${DEMO_OWNER_TOKEN:?DEMO_OWNER_TOKEN is required}"
repo_root="$(cd -- "${REPO_ROOT:?REPO_ROOT is required}" && pwd -P)"
artifact_root="$(cd -- "${ARTIFACT_ROOT:?ARTIFACT_ROOT is required}" && pwd -P)"

if ! [[ "$owner_token" =~ ^[a-f0-9]{32}$ ]] ||
  [ "$artifact_root" != "$repo_root/.demo-runtime" ]; then
  echo 'Invalid Demo ownership boundary' >&2
  exit 1
fi

compose() {
  DEMO_OWNER_TOKEN="$owner_token" POSTGRES_PORT=55432 REDIS_PORT=56379 \
    docker compose \
    --project-name "$compose_project" \
    -f "$repo_root/infrastructure/compose.yaml" \
    -f "$repo_root/infrastructure/demo.compose.yaml" \
    "$@"
}

container_owner() {
  docker inspect \
    --format "{{ index .Config.Labels \"$owner_label\" }}" \
    "$1" 2>/dev/null
}

assert_owned_container() {
  local name="$1"
  if [ "$(container_owner "$name")" != "$owner_token" ]; then
    echo "Owner mismatch for $name" >&2
    return 1
  fi
}

project_containers() {
  docker ps -a \
    --filter "label=com.docker.compose.project=$compose_project" \
    --format '{{.Names}}'
}

assert_owned_project() {
  local name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    assert_owned_container "$name"
  done < <(project_containers)
}

infra_up() {
  assert_owned_project
  compose up -d --wait
  assert_owned_project
  printf '%s\n' 'STAY_FABLE_DEMO_INFRA_READY'
}

assert_service_container() {
  local name="$1"
  assert_owned_container "$name"
  [ "$(docker inspect --format '{{.State.Running}}' "$name")" = 'true' ]
  [ "$(docker inspect --format '{{.Config.User}}' "$name")" = 'node' ]
  [ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$name")" = 'true' ]
  [ "$(docker inspect --format '{{.RestartCount}}' "$name")" = '0' ]
}

wait_for_api() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent --show-error \
      --connect-timeout 1 --max-time 2 \
      http://127.0.0.1:3000/health/live >/dev/null &&
      curl --fail --silent --show-error \
        --connect-timeout 1 --max-time 2 \
        http://127.0.0.1:3000/health/ready >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo 'Demo API did not become ready within 60 seconds' >&2
  return 1
}

services_up() {
  local common_security=(
    --user node
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges
    --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --label "$owner_label=$owner_token"
    --network "${compose_project}_default"
  )

  assert_owned_project
  for name in "$api_container" "$worker_container"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      echo "Refusing to replace existing container $name" >&2
      return 1
    fi
  done

  docker run -d \
    --name "$api_container" \
    "${common_security[@]}" \
    -p 127.0.0.1:3000:3000 \
    -e NODE_ENV=development \
    -e PORT=3000 \
    -e 'DATABASE_URL=postgresql://stay_fable:local_only_password@postgres:5432/stay_fable?schema=public&sslmode=disable' \
    -e REDIS_URL=redis://redis:6379 \
    -e IDENTITY_PROVIDER=mock \
    -e ENABLE_MOCK_PAYMENT=true \
    -e SESSION_ACCESS_TTL_SECONDS=7200 \
    -e SESSION_REFRESH_TTL_SECONDS=2592000 \
    -e LOCATION_MAX_DISTANCE_METERS=100000 \
    -e LOG_LEVEL=info \
    -v "$artifact_root/api:/app:ro" \
    -w /app \
    "$node_image" \
    node dist/main.js >/dev/null

  docker run -d \
    --name "$worker_container" \
    "${common_security[@]}" \
    -e NODE_ENV=development \
    -e 'DATABASE_URL=postgresql://stay_fable:local_only_password@postgres:5432/stay_fable?schema=public&sslmode=disable' \
    -e REDIS_URL=redis://redis:6379 \
    -e LOG_LEVEL=info \
    -v "$artifact_root/worker:/app:ro" \
    -w /app \
    "$node_image" \
    node dist/main.js >/dev/null

  wait_for_api
  status_runtime
}

status_runtime() {
  local postgres_id redis_id
  assert_owned_project
  postgres_id="$(compose ps -q postgres)"
  redis_id="$(compose ps -q redis)"
  [ -n "$postgres_id" ] && [ -n "$redis_id" ]
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$postgres_id")" = 'healthy' ]
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$redis_id")" = 'healthy' ]
  assert_service_container "$api_container"
  assert_service_container "$worker_container"
  if docker logs "$worker_container" 2>&1 |
    grep -Eqi 'reconnect(ion)? +loop|ECONN[A-Z_]*|uncaught|unhandled|fatal'; then
    echo 'Worker logs contain a failure or reconnect loop' >&2
    return 1
  fi
  curl --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    http://127.0.0.1:3000/health/live >/dev/null
  curl --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    http://127.0.0.1:3000/health/ready >/dev/null
  printf '%s\n' 'STAY_FABLE_DEMO_READY http://127.0.0.1:3000'
}

down_runtime() {
  local name remaining_containers remaining_networks
  for name in "$api_container" "$worker_container"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      assert_owned_container "$name"
      docker rm -f "$name" >/dev/null
    fi
  done

  if [ -n "$(project_containers)" ]; then
    assert_owned_project
    compose down
  fi

  remaining_containers="$(project_containers)"
  remaining_networks="$(
    docker network ls \
      --filter "label=com.docker.compose.project=$compose_project" \
      --format '{{.Name}}'
  )"
  if [ -n "$remaining_containers" ] || [ -n "$remaining_networks" ]; then
    echo 'Owned Demo resources remain after shutdown' >&2
    return 1
  fi
  printf '%s\n' 'STAY_FABLE_DEMO_DOWN'
}

case "$action" in
  infra-up)
    infra_up
    ;;
  services-up)
    services_up
    ;;
  status)
    status_runtime
    ;;
  down)
    down_runtime
    ;;
  *)
    echo "Unsupported Demo action: $action" >&2
    exit 2
    ;;
esac
