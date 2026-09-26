#!/usr/bin/env bash
# HajjCare API — contract conformance check.
#
# Run this GREEN before giving the Flutter developer a base URL. Every check here maps to a rule in
# BACKEND_SPEC.md that the app breaks on. A failure is not a style issue: it is a pilgrim unable to
# sign in, or signed out in Mina.
#
#   chmod +x verify-contract.sh
#   ./verify-contract.sh https://api.hajjcare.example/v1
#
# Requires: curl, jq
#
# Test addresses: every run registers fresh accounts, by default @hajjcare.test (no mailbox). Against
# a server that sends REAL email, export OTP_EMAIL=<a mailbox you can read>: every registered
# address becomes local+contract-<stamp>-<n>@domain in that mailbox, so nothing is sent to a domain
# that does not exist. Unknown-address probes (which send nothing) stay on hajjcare.test.
#
# Checks marked [MANUAL] need the OTP from the reset email the run itself triggers. With OTP_EMAIL
# set, the run pauses and asks for the code sent to the address it prints (blank skips).

set -uo pipefail
BASE="${1:-http://localhost:3000/v1}"
PASS=0; FAIL=0
STAMP="$(date +%s)$RANDOM"
OTP_EMAIL="${OTP_EMAIL:-}"
if [ -n "$OTP_EMAIL" ]; then
  case "$OTP_EMAIL" in
    ?*@?*) ;;
    *) echo "OTP_EMAIL is not an email address: $OTP_EMAIL" >&2; exit 2 ;;
  esac
fi
ADDRESS_COUNT=0
# registered_address LABEL -> sets $ADDRESS: an address this run REGISTERS.
registered_address() {
  ADDRESS_COUNT=$((ADDRESS_COUNT+1))
  if [ -n "$OTP_EMAIL" ]; then
    ADDRESS="${OTP_EMAIL%@*}+contract-${STAMP}-${ADDRESS_COUNT}@${OTP_EMAIL##*@}"
  else
    ADDRESS="$1+${STAMP}@hajjcare.test"
  fi
}
registered_address contract; EMAIL="$ADDRESS"
# The same account in another case: the server must match addresses case-insensitively.
EMAIL_UPPER="$(printf '%s' "$EMAIL" | tr '[:lower:]' '[:upper:]')"
PASSWORD="correct horse battery staple"
# The truncation probe: two passwords that share their first 72 bytes and differ after.
# bcrypt silently truncates at 72 bytes, so on a bcrypt server BOTH unlock the account.
LONG_PREFIX="$(printf 'a%.0s' {1..80})"
LONG_PASSWORD="${LONG_PREFIX}X"
LONG_PASSWORD_SAME_72="${LONG_PREFIX}Y"

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      got: %s\n' "$2"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# req METHOD PATH [JSON] [AUTH] -> sets $STATUS and $BODY
req() {
  local m="$1" p="$2" d="${3:-}" a="${4:-}" out
  local args=(-s -o /tmp/cc_body -w '%{http_code}' -X "$m" "$BASE$p"
              -H 'Content-Type: application/json' -H 'Accept: application/json')
  [ -n "$d" ] && args+=(-d "$d")
  [ -n "$a" ] && args+=(-H "Authorization: Bearer $a")
  STATUS="$(curl "${args[@]}")"
  BODY="$(cat /tmp/cc_body)"
}
jqt() { echo "$BODY" | jq -r "$1" 2>/dev/null; }   # jq on the last body

head_ "1. Register — $EMAIL"
req POST /auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"fullName\":\"Contract Test\"}"
case "$STATUS" in
  200|201) ok "register returns $STATUS" ;;
  *)       bad "register should be 200 or 201" "$STATUS $BODY" ;;
esac
[ "$(jqt 'has("data") or has("success")')" = "false" ] \
  && ok "no data/success envelope" || bad "RULE 2: response is wrapped in an envelope" "$BODY"
[ "$(jqt '.user.id | type')" = "string" ] \
  && ok "user.id is a JSON string" || bad "RULE 4: user.id must be a string" "$(jqt '.user.id')"
# `// empty` so a missing id reads as blank, not as the string "null"
[ -n "$(jqt '.user.id // empty | strings' | tr -d '[:space:]')" ] \
  && ok "user.id is non-blank" || bad "RULE 4: user.id is blank — the client refuses the session"
EV="$(jqt '.user.emailVerified | type')"
[ "$EV" = "boolean" ] || [ "$EV" = "null" ] \
  && ok "emailVerified is a boolean (or absent)" || bad "RULE 3: emailVerified must be true/false, not 1 or \"true\"" "$EV"
EX="$(jqt '.tokens.expiresIn | type')"
[ "$EX" = "number" ] || [ "$EX" = "null" ] \
  && ok "expiresIn is a number (or absent)" || bad "RULE 3: expiresIn must be a JSON number, not a string" "$EX"
[ "$(jqt '.tokens.accessToken | type')" = "string" ] \
  && ok "accessToken present" || bad "accessToken missing or not a string"
[ "$(jqt '.tokens.refreshToken | type')" = "string" ] \
  && ok "refreshToken present" || bad "refreshToken missing or not a string"
# USER_ID, not UID: UID is a readonly bash variable, so assigning to it silently fails.
ACCESS="$(jqt '.tokens.accessToken')"; REFRESH="$(jqt '.tokens.refreshToken')"
USER_ID="$(jqt '.user.id // empty | strings')"

head_ "2. Register — duplicate, validation"
req POST /auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"fullName\":\"Dup\"}"
[ "$STATUS" = "409" ] && ok "duplicate → 409" || bad "duplicate must be 409" "$STATUS"
[ "$(jqt '.code')" = "email_taken" ] && ok "code = email_taken" || bad "code must be email_taken" "$(jqt '.code')"
[ "$(jqt '.code | type')" = "string" ] && ok "error code is a string" || bad "RULE: error code must be a string"

registered_address short
req POST /auth/register "{\"email\":\"$ADDRESS\",\"password\":\"1234567\",\"fullName\":\"Short\"}"
[ "$STATUS" = "422" ] && ok "7-char password → 422" || bad "short password must be 422" "$STATUS"
[ "$(jqt '.errors[]? | select(.field=="password") | .code')" = "password_too_short" ] \
  && ok "field password = password_too_short" || bad "missing the password_too_short field error" "$BODY"

registered_address eight
req POST /auth/register "{\"email\":\"$ADDRESS\",\"password\":\"12345678\",\"fullName\":\"Eight\"}"
case "$STATUS" in 200|201) ok "8-char password accepted" ;; *) bad "8 chars is the floor, must be accepted" "$STATUS" ;; esac

head_ "3. Passwords — no truncation, case-insensitive email"
registered_address long; LONGMAIL="$ADDRESS"
req POST /auth/register "{\"email\":\"$LONGMAIL\",\"password\":\"$LONG_PASSWORD\",\"fullName\":\"Long\"}"
case "$STATUS" in 200|201) ok "81-char passphrase accepted" ;; *) bad "long passphrase rejected" "$STATUS" ;; esac
req POST /auth/login "{\"email\":\"$LONGMAIL\",\"password\":\"$LONG_PASSWORD\"}"
[ "$STATUS" = "200" ] && ok "long passphrase authenticates" \
  || bad "long passphrase does not authenticate" "$STATUS"
req POST /auth/login "{\"email\":\"$LONGMAIL\",\"password\":\"$LONG_PASSWORD_SAME_72\"}"
[ "$STATUS" = "401" ] && [ "$(jqt '.code')" = "invalid_credentials" ] \
  && ok "a different password sharing the first 72 bytes → 401 invalid_credentials (no truncation)" \
  || bad "RULE: a different password sharing the first 72 bytes was not refused — the server truncates passwords (bcrypt?)" "$STATUS $BODY"

req POST /auth/login "{\"email\":\"$EMAIL_UPPER\",\"password\":\"$PASSWORD\"}"
[ "$STATUS" = "200" ] && ok "email matched case-insensitively" \
  || bad "server must lowercase email — the client does not" "$STATUS"

head_ "4. Login"
req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
[ "$STATUS" = "200" ] && ok "login → 200" || bad "login failed" "$STATUS $BODY"
[ -n "$USER_ID" ] && [ "$(jqt '.user.id // empty | strings')" = "$USER_ID" ] && ok "user.id stable across register and login" \
  || bad "RULE 4: user.id changed — local health data would be orphaned"
req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"wrong password here\"}"
[ "$STATUS" = "401" ] && ok "wrong password → 401" || bad "wrong password must be 401" "$STATUS"
[ "$(jqt '.code')" = "invalid_credentials" ] && ok "code = invalid_credentials" || bad "code must be invalid_credentials" "$(jqt '.code')"
req POST /auth/login "{\"email\":\"nobody+${STAMP}@hajjcare.test\",\"password\":\"whatever long\"}"
[ "$STATUS" = "401" ] && ok "unknown email → 401 (no enumeration)" || bad "unknown email must be 401, never 404" "$STATUS"

head_ "5. Login and register must never 429 (RULE 10)"
L429=0
for _ in $(seq 1 20); do
  req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"still wrong pw\"}"
  [ "$STATUS" = "429" ] && L429=1 && break
done
[ "$L429" = "0" ] && ok "20 failed logins, no 429" || bad "RULE 10: login returned 429 — wording is nonsense on a sign-in form"
R429=0
for i in $(seq 1 10); do
  registered_address "rl${i}"
  req POST /auth/register "{\"email\":\"$ADDRESS\",\"password\":\"$PASSWORD\",\"fullName\":\"RL\"}"
  [ "$STATUS" = "429" ] && R429=1 && break
done
[ "$R429" = "0" ] && ok "10 registers, no 429" || bad "RULE 10: register returned 429"

head_ "6. /auth/me"
req GET /auth/me "" "$ACCESS"
[ "$STATUS" = "200" ] && ok "me → 200" || bad "me failed" "$STATUS $BODY"
[ "$(jqt 'has("user")')" = "false" ] && ok "bare AuthUser, not wrapped in {user:…}" || bad "me must return a bare user object" "$BODY"
[ -n "$USER_ID" ] && [ "$(jqt '.id // empty | strings')" = "$USER_ID" ] && ok "me returns the same id" || bad "id mismatch on /auth/me"
req GET /auth/me "" "definitely.not.a.valid.token"
[ "$STATUS" = "401" ] && ok "bad token → 401 (not 403)" || bad "RULE 6: expired/invalid token must be 401, never 403" "$STATUS"

head_ "7. Refresh — the only endpoint that can sign a pilgrim out"
req POST /auth/refresh "{\"refreshToken\":\"$REFRESH\"}"
[ "$STATUS" = "200" ] && ok "refresh → 200" || bad "refresh failed" "$STATUS $BODY"
[ "$(jqt '.tokens.refreshToken | type')" = "string" ] \
  && ok "refreshToken returned (required even without rotation)" || bad "refreshToken missing from refresh response"
NEW_REFRESH="$(jqt '.tokens.refreshToken')"
req POST /auth/refresh "{\"refreshToken\":\"$REFRESH\"}"
case "$STATUS" in
  200) ok "old token still works while its child is unused (or no rotation)" ;;
  401) bad "old token rejected before its child was used — a lost response or a refresh race will sign a pilgrim out" ;;
  *)   bad "unexpected status reusing the old refresh token" "$STATUS" ;;
esac
req POST /auth/refresh '{"refreshToken":"this-token-never-existed"}'
[ "$STATUS" = "401" ] && ok "unknown refresh token → 401 (a deliberate sign-out)" || bad "unknown refresh token should be 401" "$STATUS"
req POST /auth/refresh '{}'
[ "$STATUS" != "401" ] && [ "$STATUS" != "403" ] \
  && ok "malformed refresh body → $STATUS, not 401" \
  || bad "RULE 5: a malformed body returned $STATUS — this signs pilgrims out. Use 400/503"
req POST /auth/refresh 'not json at all'
[ "$STATUS" != "401" ] && [ "$STATUS" != "403" ] \
  && ok "unparseable refresh body → $STATUS, not 401" \
  || bad "RULE 5: unparseable body returned $STATUS — signs pilgrims out"

head_ "8. Forgot password — no enumeration"
req POST /auth/forgot-password "{\"email\":\"$EMAIL\"}"
S1="$STATUS"; B1="$BODY"
[ "$S1" = "200" ] && ok "known address → 200" || bad "forgot-password must be 200" "$S1"
[ "$(jqt '.codeLength')" = "6" ] && ok "codeLength = 6" || bad "codeLength must be 6 — the copy says so in 7 languages" "$(jqt '.codeLength')"
[ "$(jqt '.codeLength | type')" = "number" ] && ok "codeLength is a number" || bad "RULE 3: codeLength must be a number, not a string"
[ "$(jqt '.expiresInSeconds | type')" = "number" ] && ok "expiresInSeconds is a number" || bad "expiresInSeconds must be a number"
[ "$(jqt '.resendAfterSeconds | type')" = "number" ] && ok "resendAfterSeconds is a number" || bad "resendAfterSeconds must be a number"
req POST /auth/forgot-password "{\"email\":\"ghost+${STAMP}@hajjcare.test\"}"
[ "$STATUS" = "200" ] && ok "unknown address → 200" || bad "unknown address must also be 200, never 404" "$STATUS"
[ "$BODY" = "$B1" ] && ok "bodies are byte-identical for known and unknown" \
  || bad "bodies differ — this is an account-enumeration oracle" "known=$B1 unknown=$BODY"

head_ "9. verify-otp"
req POST /auth/verify-otp "{\"email\":\"$EMAIL\",\"code\":\"000000\"}"
WRONG_CODE="$(jqt '.code')"
if { [ "$STATUS" = "400" ] && [ "$WRONG_CODE" = "invalid_otp" ]; } \
   || { [ "$STATUS" = "429" ] && [ "$WRONG_CODE" = "too_many_attempts" ]; }; then
  ok "wrong code → $STATUS $WRONG_CODE"
else
  bad "wrong code should be 400 invalid_otp (or 429 too_many_attempts if locked out)" "$STATUS $BODY"
fi
[ "$STATUS" != "404" ] && ok "not 404" || bad "RULE 7: verify-otp must never 404"
req POST /auth/verify-otp "{\"email\":\"ghost+${STAMP}@hajjcare.test\",\"code\":\"000000\"}"
[ "$(jqt '.code')" = "invalid_otp" ] && ok "unknown address → invalid_otp, same as a wrong code" \
  || bad "unknown address must answer invalid_otp, never account_not_found or 404" "$STATUS $BODY"

head_ "10. reset-password"
req POST /auth/reset-password '{"resetToken":"rst_never_issued","password":"a brand new password"}'
[ "$STATUS" = "400" ] && ok "bad reset token → 400" || bad "bad reset token should be 400" "$STATUS"
[ "$(jqt '.code')" = "invalid_reset_token" ] && ok "code = invalid_reset_token" || bad "code must be invalid_reset_token" "$(jqt '.code')"
req POST /auth/reset-password '{"resetToken":"rst_never_issued","password":"short"}'
[ "$STATUS" = "422" ] || [ "$STATUS" = "400" ] && ok "short password on reset → $STATUS" || bad "unexpected status" "$STATUS"

head_ "11. Logout — always 204, always idempotent"
req POST /auth/logout "{\"refreshToken\":\"$NEW_REFRESH\"}"
[ "$STATUS" = "204" ] && ok "valid token → 204" || bad "logout must return 204" "$STATUS"
req POST /auth/logout "{\"refreshToken\":\"$NEW_REFRESH\"}"
[ "$STATUS" = "204" ] && ok "already-revoked token → 204 (idempotent)" || bad "logout must be idempotent" "$STATUS"
req POST /auth/logout '{"refreshToken":""}'
[ "$STATUS" = "204" ] && ok "empty string token → 204" || bad "an empty refreshToken is normal — must be 204, not 400/422" "$STATUS"
req POST /auth/logout '{"refreshToken":"unknown-token-value"}'
[ "$STATUS" = "204" ] && ok "unknown token → 204" || bad "unknown token must be 204" "$STATUS"

head_ "12. Status discipline under /auth (RULES 7, 8, 9)"
for p in /auth/does-not-exist /auth/login/extra /auth/ /auth/register/x; do
  req POST "$p" '{}'
  [ "$STATUS" = "404" ] && bad "RULE 7: $p returned 404 — renders as 'no account for that email'" \
                        || ok "$p → $STATUS (not 404)"
done
for p in /auth/register /auth/forgot-password /auth/verify-otp /auth/reset-password; do
  req POST "$p" '{}'
  if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
    bad "RULE 9: $p returned $STATUS — shows 'email and password do not match' on the wrong screen"
  else
    ok "$p on empty body → $STATUS (not 401/403)"
  fi
  [ "$STATUS" = "409" ] && bad "RULE 8: $p returned 409 — renders as 'already has an account'" || true
done

head_ "13. [MANUAL] OTP flow"
OTP_CODE="${OTP_CODE:-}"
if [ -z "$OTP_CODE" ] && [ -n "$OTP_EMAIL" ] && [ -t 0 ]; then
  read -r -p "  Enter the 6-digit code emailed to $EMAIL (blank to skip): " OTP_CODE
fi
if [ -n "$OTP_CODE" ]; then
  req POST /auth/verify-otp "{\"email\":\"$EMAIL\",\"code\":\"$OTP_CODE\"}"
  [ "$STATUS" = "200" ] && ok "correct code → 200" || bad "correct code rejected" "$STATUS $BODY"
  RT="$(jqt '.resetToken')"
  [ "$(jqt '.resetToken | type')" = "string" ] && ok "resetToken returned" || bad "resetToken missing"
  [ "$(jqt 'has("tokens") or has("accessToken") or has("refreshToken")')" = "false" ] \
    && ok "no session issued by verify-otp" || bad "verify-otp must NOT return a session — that is a second way in"
  req POST /auth/reset-password "{\"resetToken\":\"$RT\",\"password\":\"a fresh long password\"}"
  [ "$STATUS" = "204" ] && ok "reset → 204" || bad "reset should be 204" "$STATUS"
  req POST /auth/reset-password "{\"resetToken\":\"$RT\",\"password\":\"another password\"}"
  [ "$STATUS" = "400" ] && ok "reset token is single-use" || bad "reset token reused successfully — single-use is firm" "$STATUS"
  req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"a fresh long password\"}"
  [ "$STATUS" = "200" ] && ok "new password works" || bad "new password does not authenticate" "$STATUS"
else
  printf '  \033[33m•\033[0m skipped — set OTP_EMAIL to a mailbox you can read and re-run; the run will ask for the code\n'
fi

printf '\n\033[1mPassed: %d   Failed: %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && printf '\033[32mContract conformant. Safe to hand the base URL to the app developer.\033[0m\n' \
                  || printf '\033[31mDo NOT hand over the base URL yet.\033[0m\n'
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
