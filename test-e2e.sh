#!/usr/bin/env bash
# End-to-end local OAuth 2.1 + MCP test through the gateway (127.0.0.1:8010).
set -euo pipefail
cd "$(dirname "$0")"
PASSPHRASE=$(cut -d= -f2- CONSENT_PASSPHRASE.txt)
GW=http://127.0.0.1:8010

# 1. Dynamic client registration
REG=$(curl -s -X POST $GW/register -H 'Content-Type: application/json' \
  -d '{"client_name":"local-e2e-test","redirect_uris":["http://127.0.0.1/callback"],"grant_types":["authorization_code","refresh_token"],"token_endpoint_auth_method":"none","response_types":["code"]}')
CLIENT_ID=$(echo "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["client_id"])')
echo "registered client_id: ${CLIENT_ID:0:12}..."

# 2. PKCE + authorize (GET -> consent form) then consent (POST -> 302 with code)
VERIFIER=$(head -c 48 /dev/urandom | basenc --base64url | tr -d '=+/' | head -c 64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | basenc --base64url | tr -d '=')
AUTH_URL="$GW/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&scope=mcp&state=xyz123&code_challenge=$CHALLENGE&code_challenge_method=S256&resource=https%3A%2F%2Fjacen-ubuntu.tailaa6d41.ts.net%2Fmcp"
# consent form present?
FORM=$(curl -s "$AUTH_URL")
echo "$FORM" | grep -q 'Consent passphrase' && echo "consent form: OK"
LOCATION=$(curl -s -o /dev/null -D - -X POST "$GW/authorize/consent" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=http://127.0.0.1/callback" \
  --data-urlencode "scope=mcp" \
  --data-urlencode "state=xyz123" \
  --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=https://jacen-ubuntu.tailaa6d41.ts.net/mcp" \
  --data-urlencode "passphrase=$PASSPHRASE" | grep -i '^location:' | tr -d '\r' | cut -d' ' -f2)
CODE=$(python3 -c "import sys,urllib.parse as u; q=u.parse_qs(u.urlparse(sys.argv[1]).query); print(q['code'][0])" "$LOCATION")
echo "authorization code obtained (iss=$(python3 -c "import sys,urllib.parse as u; q=u.parse_qs(u.urlparse(sys.argv[1]).query); print(q.get('iss'))" "$LOCATION"), state=$(python3 -c "import sys,urllib.parse as u; q=u.parse_qs(u.urlparse(sys.argv[1]).query); print(q['state'][0])" "$LOCATION"))"

# 3. Token exchange with PKCE verification
TOKENS=$(curl -s -X POST $GW/token -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=http://127.0.0.1/callback")
ACCESS=$(echo "$TOKENS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
REFRESH=$(echo "$TOKENS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["refresh_token"])')
echo "token exchange: OK (access ${#ACCESS} chars, refresh ${#REFRESH} chars)"

# 4. Authenticated MCP initialize + tools/list through the gateway
RSP=$(curl -s -D /tmp/e2e-headers.txt -X POST $GW/mcp -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')
INIT="$RSP"
SESSION=$(grep -i '^mcp-session-id:' /tmp/e2e-headers.txt | tr -d '\r' | cut -d' ' -f2)
echo "session: ${SESSION:0:12}..."
curl -s -o /dev/null -X POST $GW/mcp -H "Authorization: Bearer $ACCESS" -H "Mcp-Session-Id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS=$(curl -s -X POST $GW/mcp -H "Authorization: Bearer $ACCESS" -H "Mcp-Session-Id: $SESSION" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "tools/list count: $(echo "$TOOLS" | grep -o '"name":"' | wc -l)"
echo "$TOOLS" | grep -o '"name":"[a-z_]*"' | head -6

# 5. Refresh grant (rotation)
T2=$(curl -s -X POST $GW/token -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$REFRESH" --data-urlencode "client_id=$CLIENT_ID")
echo "refresh rotation: $(echo "$T2" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("OK" if d.get("access_token") else "FAIL "+str(d))')"
T3=$(curl -s -X POST $GW/token -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$REFRESH" --data-urlencode "client_id=$CLIENT_ID")
echo "refresh replay rejected: $(echo "$T3" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error"))')"

# 6. Tampered / wrong-audience token rejected
BAD=$(echo "$ACCESS" | cut -d. -f1-2).AAAA
echo "tampered token -> $(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/mcp -H "Authorization: Bearer $BAD" -H 'Content-Type: application/json' -d '{}')"
