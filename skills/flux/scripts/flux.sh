#!/bin/bash

# Flux Image Generation Script
# Usage: ./flux.sh "<positive_prompt>" [--negative_prompt "<negative_prompt>"] [--model <model>] [--seed <seed>] [--width <width>] [--height <height>] [--steps <steps>] [--cfg <cfg>] [--allow_fallback <true/false>]

# Default values
NEGATIVE_PROMPT=""
MODEL="flux1-schnell-Q5_K_S.gguf"
SEED=12345
WIDTH=512
HEIGHT=512
STEPS=4
CFG=1
ALLOW_FALLBACK=true
OUTPUT_FILE="output.png"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --negative_prompt)
            NEGATIVE_PROMPT="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --seed)
            SEED="$2"
            shift 2
            ;;
        --width)
            WIDTH="$2"
            shift 2
            ;;
        --height)
            HEIGHT="$2"
            shift 2
            ;;
        --steps)
            STEPS="$2"
            shift 2
            ;;
        --cfg)
            CFG="$2"
            shift 2
            ;;
        --allow_fallback)
            ALLOW_FALLBACK="$2"
            shift 2
            ;;
        *)
            POSITIVE_PROMPT="$1"
            shift
            ;;
    esac
 done

# Validate required arguments
if [[ -z "$POSITIVE_PROMPT" ]]; then
    echo "Error: Positive prompt is required."
    echo "Usage: $0 \"<positive_prompt>\" [--negative_prompt \"<negative_prompt>\"] [--model <model>] [--seed <seed>] [--width <width>] [--height <height>] [--steps <steps>] [--cfg <cfg>] [--allow_fallback <true/false>]"
    exit 1
fi

# Craft the JSON payload
PAYLOAD=$(jq -n \
    --arg positive_prompt "$POSITIVE_PROMPT" \
    --arg negative_prompt "$NEGATIVE_PROMPT" \
    --arg model "$MODEL" \
    --argjson seed "$SEED" \
    --argjson width "$WIDTH" \
    --argjson height "$HEIGHT" \
    --argjson steps "$STEPS" \
    --argjson cfg "$CFG" \
    --argjson allow_fallback "$ALLOW_FALLBACK" \
    '{
        positive_prompt: $positive_prompt,
        negative_prompt: $negative_prompt,
        model: $model,
        seed: $seed,
        width: $width,
        height: $height,
        steps: $steps,
        cfg: $cfg,
        allow_fallback: $allow_fallback
    }'
)

# Send the request
echo "Generating image with Flux..."
RESPONSE=$(curl -s -X POST "http://kamrui.local:32001/generate" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

# Check for errors
if echo "$RESPONSE" | jq -e '.status != "success"' > /dev/null; then
    echo "Error: $(echo "$RESPONSE" | jq -r '.message // .status')"
    exit 1
fi

# Extract and decode the base64 image
IMAGE_BASE64=$(echo "$RESPONSE" | jq -r '.data.images[0]')
if [[ -z "$IMAGE_BASE64" || "$IMAGE_BASE64" == "null" ]]; then
    echo "Error: No image data in response."
    exit 1
fi

echo "$IMAGE_BASE64" | base64 --decode > "$OUTPUT_FILE"

# Output success message
echo "Image generated successfully: $OUTPUT_FILE"
echo "Parameters used:"
echo "$RESPONSE" | jq '.data.parameters'