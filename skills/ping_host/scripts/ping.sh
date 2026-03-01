#!/bin/bash

# Default values
COUNT=4
TIMEOUT=2

# Parse arguments
while getopts "c:W:" opt; do
  case $opt in
    c) COUNT="$OPTARG" ;;
    W) TIMEOUT="$OPTARG" ;;
    *) echo "Usage: $0 <host> [-c count] [-W timeout]"; exit 1 ;;
  esac
 done
shift $((OPTIND - 1))

# Check if host is provided
if [ -z "$1" ]; then
  echo "Error: Host is required."
  echo "Usage: $0 <host> [-c count] [-W timeout]"
  exit 1
fi

HOST="$1"

# Run ping
ping -c "$COUNT" -W "$TIMEOUT" "$HOST" 2>&1 | grep -v "PING" | head -n -2
EXIT_CODE=${PIPESTATUS[0]}

# Check result
if [ $EXIT_CODE -eq 0 ]; then
  echo "<b>✅ Success:</b> Host <code>$HOST</code> is reachable."
else
  echo "<b>❌ Error:</b> Host <code>$HOST</code> is unreachable."
  exit 1
fi