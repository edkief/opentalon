---
name: flux
description: >-
  Use this skill when the user wants to generate an image using the Flux model
  via the /generate endpoint.
license: None
---
# Flux Image Generation Skill

## Purpose
Generate images using the Flux model via the `/generate` endpoint exposed at `http://kamrui.local:32001`. This skill supports the **correct API request/response structure** for Flux image generation.

---

## Endpoint
- **URL:** `http://kamrui.local:32001/generate`
- **Method:** `POST`
- **Content-Type:** `application/json`

---

## Parameters
| Parameter         | Type    | Required | Description                                  | Example                          |
|-------------------|---------|----------|----------------------------------------------|----------------------------------|
| `positive_prompt` | string  | Yes      | Description of the image to generate.        | "A cyber samurai fox in snow"  |
| `negative_prompt` | string  | No       | What to avoid in the image.                  | "blurry, low quality"          |
| `model`           | string  | No       | Model to use (default: `flux1-schnell-Q5_K_S.gguf`). | `flux1-schnell-Q5_K_S.gguf` |
| `seed`            | integer | No       | Seed for reproducibility (default: `12345`). | `42`                             |
| `width`           | integer | No       | Image width (default: `512`).                | `512`                            |
| `height`          | integer | No       | Image height (default: `512`).               | `512`                            |
| `steps`           | integer | No       | Number of steps (default: `4`).              | `4`                              |
| `cfg`             | integer | No       | CFG scale (default: `1`).                    | `1`                              |
| `allow_fallback`  | boolean | No       | Allow fallback to CPU if GPU fails (default: `true`). | `true` |

---

## Response Structure
The endpoint returns a JSON response with the following structure:

```json
{
  "status": "success",
  "data": {
    "model": "flux",
    "images": [
      "iVBORw0KGgoAAAANSUhEUgAA..."  // Base64-encoded image
    ],
    "parameters": {
      "positive_prompt": "The mysterious universe",
      "negative_prompt": "",
      "seed": 4001327375,
      "width": 512,
      "height": 512,
      "steps": 4,
      "cfg": 1
    }
  }
}
```

---

## Examples
### Example 1: Basic Generation
```json
{
  "positive_prompt": "A cyber samurai fox in a snowy forest",
  "negative_prompt": "blurry, low quality",
  "model": "flux1-schnell-Q5_K_S.gguf",
  "seed": 12345,
  "width": 512,
  "height": 512,
  "steps": 4,
  "cfg": 1,
  "allow_fallback": true
}
```

### Example 2: Custom Seed and Dimensions
```json
{
  "positive_prompt": "A futuristic city at night",
  "model": "flux1-schnell-Q5_K_S.gguf",
  "seed": 42,
  "width": 768,
  "height": 512,
  "steps": 6,
  "cfg": 1.5,
  "allow_fallback": false
}
```

---

## Script
Use the `flux.sh` script to send requests to the endpoint. The script handles:
- Crafting the JSON payload with the correct structure.
- Sending the POST request.
- Decoding the base64-encoded image and saving it to a file (`output.png`).

### Script Usage
```bash
./scripts/flux.sh "<positive_prompt>" [--negative_prompt "<negative_prompt>"] [--model <model>] [--seed <seed>] [--width <width>] [--height <height>] [--steps <steps>] [--cfg <cfg>] [--allow_fallback <true/false>]
```

### Example
```bash
./scripts/flux.sh "A cyber samurai fox in a snowy forest" --negative_prompt "blurry" --width 512 --height 512 --seed 42
```

---

## Output
The script saves the generated image as `output.png` in the current directory and prints the parameters used for confirmation.
