#!/bin/bash

# Script to generate TTS audio using the Kokoro TTS API
# Usage: ./generate_tts.sh "YOUR_TEXT" VOICE_NAME OUTPUT_FILE_PATH

set -euo pipefail

TEXT="$1"
VOICE="$2"
OUTPUT_FILE="$3"
API_URL="http://kamrui.local:32001/v1/audio/speech"

# Generate audio
curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"tts-1\", \"input\": \"$TEXT\", \"voice\": \"$VOICE\", \"response_format\": \"mp3\", \"speed\": 1.0}" \
  --output "$OUTPUT_FILE"

echo "Audio generated and saved to $OUTPUT_FILE"