#!/usr/bin/env bash
set -euo pipefail

repo="${INFRAWEFT_REPOSITORY:-heyjdev/InfraWeft}"
mode="${1:---check}"
api_version="${GITHUB_API_VERSION:-2026-03-10}"

if ! command -v gh >/dev/null 2>&1; then
  printf 'GitHub CLI (gh) is required.\n' >&2
  exit 1
fi

gh_api() {
  gh api \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: ${api_version}" \
    "$@"
}

gh auth status >/dev/null
is_private="$(gh_api "repos/${repo}" --jq '.private')"

verify_public_controls() {
  local security_states codeql_state actions_policy selected_actions_policy
  local ruleset_id enforcement status_count pull_request_count

  gh_api --silent "repos/${repo}/private-vulnerability-reporting"

  security_states="$(gh_api "repos/${repo}" --jq '[.security_and_analysis.secret_scanning.status, .security_and_analysis.secret_scanning_push_protection.status] | @tsv')"
  if [[ "$security_states" != $'enabled\tenabled' ]]; then
    printf 'Secret scanning controls are not both enabled: %s\n' "$security_states" >&2
    return 1
  fi

  codeql_state="$(gh_api "repos/${repo}/code-scanning/default-setup" --jq '.state')"
  if [[ "$codeql_state" != "configured" ]]; then
    printf 'CodeQL default setup is not configured: %s\n' "$codeql_state" >&2
    return 1
  fi

  actions_policy="$(gh_api "repos/${repo}/actions/permissions" --jq '[.enabled, .allowed_actions, .sha_pinning_required] | @tsv')"
  if [[ "$actions_policy" != $'true\tselected\ttrue' ]]; then
    printf 'Actions policy verification failed: %s\n' "$actions_policy" >&2
    return 1
  fi

  selected_actions_policy="$(gh_api "repos/${repo}/actions/permissions/selected-actions" --jq '[.github_owned_allowed, .verified_allowed, (.patterns_allowed | length)] | @tsv')"
  if [[ "$selected_actions_policy" != $'true\tfalse\t0' ]]; then
    printf 'Actions allowlist verification failed: %s\n' "$selected_actions_policy" >&2
    return 1
  fi

  ruleset_id="$(gh_api "repos/${repo}/rulesets" --jq 'map(select(.name == "Public main protection")) | first | .id // empty')"
  if [[ -z "$ruleset_id" ]]; then
    printf 'Public main protection ruleset is missing.\n' >&2
    return 1
  fi

  enforcement="$(gh_api "repos/${repo}/rulesets/${ruleset_id}" --jq '.enforcement')"
  status_count="$(gh_api "repos/${repo}/rulesets/${ruleset_id}" --jq '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]] | length')"
  pull_request_count="$(gh_api "repos/${repo}/rulesets/${ruleset_id}" --jq '[.rules[] | select(.type == "pull_request")] | length')"

  if [[ "$enforcement" != "active" || "$status_count" != "10" || "$pull_request_count" != "1" ]]; then
    printf 'Ruleset verification failed: enforcement=%s required_checks=%s pull_request_rules=%s\n' \
      "$enforcement" "$status_count" "$pull_request_count" >&2
    return 1
  fi

  printf 'private_vulnerability_reporting=enabled\n'
  printf 'secret_scanning=enabled push_protection=enabled\n'
  printf 'codeql_default_setup=configured\n'
  printf 'actions=enabled allowlist=github-owned-only sha_pinning=required\n'
  printf 'ruleset=%s enforcement=active required_checks=10 pull_request_rules=1\n' "$ruleset_id"
}

if [[ "$mode" == "--check" ]]; then
  printf 'repository=%s private=%s api_version=%s\n' "$repo" "$is_private" "$api_version"
  if [[ "$is_private" == "true" ]]; then
    printf 'Cutover is blocked while the repository is private. No settings were changed.\n'
    exit 0
  fi
  verify_public_controls
  exit 0
fi

if [[ "$mode" != "--apply" ]]; then
  printf 'Usage: %s [--check|--apply]\n' "$0" >&2
  exit 2
fi

if [[ "$is_private" != "false" ]]; then
  printf 'Refusing to apply public controls while %s is private.\n' "$repo" >&2
  exit 1
fi

gh_api --method PUT "repos/${repo}/private-vulnerability-reporting" --silent

gh_api --method PATCH "repos/${repo}" --input - --silent <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

gh_api --method PATCH "repos/${repo}/code-scanning/default-setup" --input - --silent <<'JSON'
{
  "state": "configured",
  "query_suite": "default"
}
JSON

gh_api --method PUT "repos/${repo}/actions/permissions" --input - --silent <<'JSON'
{
  "enabled": true,
  "allowed_actions": "selected",
  "sha_pinning_required": true
}
JSON

gh_api --method PUT "repos/${repo}/actions/permissions/selected-actions" --input - --silent <<'JSON'
{
  "github_owned_allowed": true,
  "verified_allowed": false,
  "patterns_allowed": []
}
JSON

ruleset_payload="$(mktemp)"
trap 'rm -f "$ruleset_payload"' EXIT
cat >"$ruleset_payload" <<'JSON'
{
  "name": "Public main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Verify · Node 20 · ubuntu-latest" },
          { "context": "Verify · Node 22 · ubuntu-latest" },
          { "context": "Verify · Node 20 · windows-latest" },
          { "context": "Verify · Node 22 · windows-latest" },
          { "context": "Verify · Node 20 · macos-latest" },
          { "context": "Verify · Node 22 · macos-latest" },
          { "context": "Package smoke · ubuntu-latest" },
          { "context": "Package smoke · windows-latest" },
          { "context": "Package smoke · macos-latest" },
          { "context": "Dependency review" }
        ]
      }
    }
  ]
}
JSON

existing_ruleset="$(gh_api "repos/${repo}/rulesets" --jq 'map(select(.name == "Public main protection")) | first | .id // empty')"
if [[ -z "$existing_ruleset" ]]; then
  gh_api --method POST "repos/${repo}/rulesets" --input "$ruleset_payload" --silent
else
  gh_api --method PUT "repos/${repo}/rulesets/${existing_ruleset}" --input "$ruleset_payload" --silent
fi

printf 'Public security controls applied to %s. Verifying...\n' "$repo"
verify_public_controls
printf 'Private report form: https://github.com/%s/security/advisories/new\n' "$repo"
