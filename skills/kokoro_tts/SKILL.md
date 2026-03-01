---
name: kokoro_tts
description: >-
  Use this skill when the user wants to generate audio from text using the TTS
  API. Supports multiple languages and voices (e.g., American, British, French,
  etc.).
license: None
---
# Kokoro TTS: Text-to-Speech Audio Generation

---

## Overview
This skill allows you to generate high-quality audio from text using the TTS API at `http://kamrui.local:32001/v1/audio/speech`. It supports multiple languages and voices, with the first character of the voice name indicating the language:
- `a`: American English
- `b`: British English
- `f`: French
- `h`: Hindi
- `i`: Italian
- `j`: Japanese
- `p`: Portuguese
- `z`: Chinese

---

## API Endpoint
`POST http://kamrui.local:32001/v1/audio/speech`

---

## Request Body
The API expects a JSON payload with the following fields:

| Field      | Type     | Description                                                                                     | Example                     |
|------------|----------|-------------------------------------------------------------------------------------------------|-----------------------------|
| `model`    | string   | The TTS model to use. Default: `tts-1`.                                                        | `tts-1`                     |
| `input`    | string   | The text to generate audio for. Max 4096 characters.                                           | `Hello, world!`             |
| `voice`    | string   | The voice to use. See **Available Voices** below.                                              | `am_onyx`                   |
| `response_format` | string | The audio format. Options: `mp3`, `opus`, `aac`, `flac`. Default: `mp3`.                      | `mp3`                       |
| `speed`    | float    | The speed of the generated audio. Range: 0.25 to 4.0. Default: `1.0`.                         | `1.0`                       |

---

## Available Voices
Here are some of the available voices, categorized by language:

### American English (`a`)
- `af_alloy`, `af_aoede`, `af_bella`, `af_heart`, `af_jadzia`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`, `af_v0`, `af_v0bella`, `af_v0irulan`, `af_v0nicole`, `af_v0sarah`, `af_v0sky`
- `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa`, `am_v0adam`, `am_v0gurney`, `am_v0michael`

### British English (`b`)
- `bf_alice`, `bf_emma`, `bf_lily`, `bf_v0emma`, `bf_v0isabella`
- `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis`, `bm_v0george`, `bm_v0lewis`

### French (`f`)
- `ff_siwis`

### Hindi (`h`)
- `hf_alpha`, `hf_beta`
- `hm_omega`, `hm_psi`

### Italian (`i`)
- `if_sara`
- `im_nicola`

### Japanese (`j`)
- `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`
- `jm_kumo`

### Portuguese (`p`)
- `pf_dora`
- `pm_alex`, `pm_santa`

### Chinese (`z`)
- `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`
- `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang`

---

## Helper Script
This skill includes a helper script, `generate_tts.sh`, to simplify the process of generating audio. The script:
1. Takes the text input, voice, and output file path as arguments.
2. Sends a request to the TTS API.
3. Saves the generated audio to the specified path.

### Usage
```bash
./scripts/generate_tts.sh "YOUR_TEXT_HERE" VOICE_NAME OUTPUT_FILE_PATH
```

### Example
```bash
./scripts/generate_tts.sh "Hello, world! This is a test of the TTS system." am_onyx output.mp3
```

---

## Steps to Use This Skill
1. **Choose a voice**: Select a voice from the **Available Voices** section based on the language and style you prefer.
2. **Prepare your text**: Ensure the text is in the correct language.
3. **Run the helper script**: Use the `generate_tts.sh` script to generate the audio.
4. **Send the audio**: Once generated, send the audio file to the user.

---

## Notes
- The default audio format is `mp3`, but you can change it to `opus`, `aac`, or `flac` if needed.
- Adjust the `speed` parameter to control the pace of the generated audio.
- If the user doesn’t specify a voice, default to `am_onyx` (American English).
