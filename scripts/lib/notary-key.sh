# shellcheck shell=bash
# Source this helper; private material is read from the environment, never argv.
notary_key_format_error() {
  echo "::error::APPLE_API_KEY is neither PEM nor base64 PEM. Re-set it from the original AuthKey_<id>.p8 using gh secret set APPLE_API_KEY < AuthKey_<id>.p8, then rerun Release Preflight before Release Bundles."
}

write_notary_key() {
  local key_file="$1" material="${APPLE_API_PRIVATE_KEY:-}"
  case "$material" in
    '-----BEGIN'*) ;;
    *)
      if ! material=$(
        set -o pipefail
        printf '%s' "$material" | tr -d '[:space:]' | base64 --decode 2>/dev/null && printf '.'
      ); then
        notary_key_format_error
        return 1
      fi
      # A sentinel preserves trailing newlines through command substitution.
      material="${material%.}"
      ;;
  esac
  case "$material" in
    '-----BEGIN PRIVATE KEY-----'*) ;;
    *) notary_key_format_error; return 1 ;;
  esac
  if ! (umask 077; printf '%s' "$material" > "$key_file" && chmod 600 "$key_file"); then
    echo "::error::Cannot write the restricted temporary notarization key. Check runner temporary-directory permissions and retry Release Preflight before Release Bundles."
    return 1
  fi
}
