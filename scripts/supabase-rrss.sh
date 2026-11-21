#!/usr/bin/env bash
# Ejecuta la CLI de Supabase contra el proyecto de rrss con su propio token,
# sin tocar la sesión global de la CLI (que en esta máquina usa otra cuenta).
#
#   bash scripts/supabase-rrss.sh <orden de supabase> [argumentos]
#   p. ej.: bash scripts/supabase-rrss.sh migration list
#
# - El token se lee de un archivo y solo vive en el entorno de este proceso:
#   ni se imprime ni se guarda en la sesión global.
# - El proyecto queda fijado: si la carpeta está enlazada a otro proyecto, o se
#   pide otro con --project-ref, la orden no se ejecuta.
set -euo pipefail

readonly PROJECT_REF="zzkdrfhqmjfvrdsoguio"
readonly TOKEN_FILE="${RRSS_SUPABASE_TOKEN_FILE:-$HOME/.supabase-rrss/token}"

if [ "$#" -eq 0 ]; then
  echo "Uso: bash scripts/supabase-rrss.sh <orden de supabase> [argumentos]" >&2
  exit 2
fi

if [ ! -s "$TOKEN_FILE" ]; then
  echo "Falta el token de rrss en $TOKEN_FILE (una sola línea, sin extensión)." >&2
  exit 2
fi

cd "$(dirname "$0")/.."

linked_file="supabase/.temp/project-ref"
if [ -f "$linked_file" ]; then
  linked="$(tr -d '\r\n' < "$linked_file")"
  if [ "$linked" != "$PROJECT_REF" ]; then
    echo "Esta carpeta está enlazada a otro proyecto ($linked): no se ejecuta nada." >&2
    exit 3
  fi
fi

previous=""
for arg in "$@"; do
  value=""
  case "$arg" in
    --project-ref=*) value="${arg#*=}" ;;
  esac
  if [ "$previous" = "--project-ref" ]; then
    value="$arg"
  fi
  if [ -n "$value" ] && [ "$value" != "$PROJECT_REF" ]; then
    echo "Solo se permite el proyecto $PROJECT_REF (se pidió $value)." >&2
    exit 3
  fi
  previous="$arg"
done

SUPABASE_ACCESS_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
export SUPABASE_ACCESS_TOKEN

exec supabase "$@"
