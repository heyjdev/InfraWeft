#!/usr/bin/env bash
set -euo pipefail

repo="${INFRAWEFT_REPOSITORY:-heyjdev/InfraWeft}"
mode="${1:---check}"

if ! command -v gh >/dev/null 2>&1; then
  printf 'GitHub CLI (gh) is required.\n' >&2
  exit 1
fi

gh auth status >/dev/null
is_private="$(gh api "repos/${repo}" --jq '.private')"

if [[ "$mode" == "--check" ]]; then
  printf 'repository=%s private=%s\n' "$repo" "$is_private"
  if [[ "$is_private" == "true" ]]; then
    printf 'Cutover is blocked while the repository is private. No settings were changed.\n'
    exit 0
  fi
  gh api -i "repos/${repo}/private-vulnerability-reporting" | sed -n '1p'
  gh api "repos/${repo}" --jq '.security_and_analysis'
  gh api "repos/${repo}/code-scanning/default-setup"
  gh api "repos/${repo}/rulesets" --jq '.[] | {id, name, enforcement}'
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

gh api --method PUT "repos/${repo}/private-vulnerability-reporting" --silent

gh api --method PATCH "repos/${repo}" --input - --silent <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

gh api --method PATCH "repos/${repo}/code-scanning/default-setup" --input - --silent <<'JSON'
{
  "state": "configured",
  "query_suite": "default"
}
JSON

existing_ruleset="$(gh api "repos/${repo}/rulesets" --jq 'map(select(.name == "Public main protection")) | first | .id // empty')"
if [[ -z "$existing_ruleset" ]]; then
  gh api --method POST "repos/${repo}/rulesets" --input - --silent <<'JSON'
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
fi

printf 'Public security controls applied to %s. Verifying...\n' "$repo"
"$0" --check
printf 'Private report form: https://github.com/%s/security/advisories/new\n' "$repo"
