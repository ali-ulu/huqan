#!/usr/bin/env bash
# Idempotent setup for the HUQAN hourly issue runner automation.
# - creates the trigger label (openhands-implement) if missing
# - re-creates the automation (deletes an existing one with the same name first)
set -euo pipefail

REPO="ali-ulu/huqan"
LABEL="openhands-implement"
NAME="HUQAN Issue Runner (saatlik)"
BASE_DEFAULT="https://app.all-hands.dev/api/automation"
PROMPT_FILE="$(dirname "$0")/issue-runner.prompt.md"

export GH_TOKEN="${GITHUB_TOKEN:-${GITHUB_PERSONAL_ACCESS_TOKEN:-}}"
[ -n "${GH_TOKEN:-}" ] || { echo "no GitHub token in env"; exit 1; }

BASE="${AUTOMATION_API_URL:-$BASE_DEFAULT}"
case "$BASE" in */v1) API="$BASE";; *) API="$BASE/v1";; esac

api() { # method url [data]
  local m="$1" u="$2" d="${3:-}" i out
  for i in 1 2 3; do
    if [ -n "$d" ]; then
      out=$(curl -s -m 30 -X "$m" -H "Authorization: Bearer $OPENHANDS_API_KEY" \
        -H "Content-Type: application/json" "$u" --data "$d")
    else
      out=$(curl -s -m 30 -X "$m" -H "Authorization: Bearer $OPENHANDS_API_KEY" "$u")
    fi
    [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 3
  done
  return 1
}

# 1) ensure the trigger label exists
if gh label list -R "$REPO" --json name --jq '.[].name' | grep -qx "$LABEL"; then
  echo "label '$LABEL' already exists"
else
  gh label create "$LABEL" -R "$REPO" \
    --color "0e8a16" \
    --description "Owner-approved for the hourly issue runner to implement"
  echo "label '$LABEL' created"
fi

# 2) remove any existing automation with the same name (idempotent re-create)
EXISTING=$(api GET "$API?limit=100" | jq -r --arg n "$NAME" '.automations[]|select(.name==$n)|.id')
for id in $EXISTING; do
  echo "removing existing automation $id"
  api DELETE "$API/$id" >/dev/null || true
done

# 3) create the automation
BODY=$(jq -n --rawfile prompt "$PROMPT_FILE" --arg name "$NAME" '{
  name: $name,
  prompt: $prompt,
  trigger: { type: "cron", schedule: "0 * * * *", timezone: "UTC" },
  repos: [{ url: "https://github.com/ali-ulu/huqan", ref: "main" }]
}')
api POST "$API/preset/prompt" "$BODY" | jq '{id, name, trigger, enabled}'