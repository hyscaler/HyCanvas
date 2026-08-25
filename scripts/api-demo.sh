#!/bin/sh
# F40 E05 acceptance: prompt -> deck -> PDF bytes -> share URL, with no
# browser session. Requires: a running HyCanvas server whose workspace has an
# AI text provider configured, and an API key with generate+read+export scopes
# (Dashboard > Members > API keys).
#
#   HYCANVAS=http://localhost:8005 HYK=hyk_... sh scripts/api-demo.sh
#
# Plain sh + curl; jq optional (falls back to sed extraction).
set -eu

: "${HYCANVAS:?set HYCANVAS to the server origin, e.g. http://localhost:8005}"
: "${HYK:?set HYK to an API key (hyk_...)}"

json_field() { # json_field <key> : first string value of "key" on stdin
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1
}

echo "1/4 generate..."
ACCEPTED=$(curl -sS -X POST "$HYCANVAS/api/v1/generate/presentation" \
  -H "Authorization: Bearer $HYK" -H "Content-Type: application/json" \
  -d '{"prompt": "a 5-slide pitch deck for a solar installer for small businesses", "pageCount": 5}')
JOB=$(printf '%s' "$ACCEPTED" | json_field jobId)
[ -n "$JOB" ] || { echo "no jobId in: $ACCEPTED" >&2; exit 1; }
echo "   job $JOB"

echo "2/4 poll..."
DESIGN=""
i=0
while [ $i -lt 120 ]; do
  BODY=$(curl -sS "$HYCANVAS/api/v1/jobs/$JOB" -H "Authorization: Bearer $HYK")
  STATUS=$(printf '%s' "$BODY" | json_field status)
  if [ "$STATUS" = "completed" ]; then
    DESIGN=$(printf '%s' "$BODY" | json_field designId)
    break
  fi
  if [ "$STATUS" = "failed" ]; then
    echo "   generation failed: $BODY" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 2
done
[ -n "$DESIGN" ] || { echo "timed out waiting for the job" >&2; exit 1; }
echo "   design $DESIGN"

echo "3/4 render PDF..."
curl -sS "$HYCANVAS/api/v1/designs/$DESIGN/render.pdf" \
  -H "Authorization: Bearer $HYK" -o /tmp/hycanvas-api-demo.pdf
ls -la /tmp/hycanvas-api-demo.pdf

echo "4/4 share link..."
LINK=$(curl -sS -X POST "$HYCANVAS/api/v1/designs/$DESIGN/links" \
  -H "Authorization: Bearer $HYK" -H "Content-Type: application/json" \
  -d '{"mode": "view", "label": "API demo"}')
TOKEN=$(printf '%s' "$LINK" | json_field token)
[ -n "$TOKEN" ] || { echo "no token in: $LINK" >&2; exit 1; }
echo "   share URL: $HYCANVAS/shared/$TOKEN/"
echo "   embed URL: $HYCANVAS/shared/$TOKEN/?embed=1"
echo "done."
