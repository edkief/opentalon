---
name: opentalon-config
description: Safely inspect, validate, and change OpenTalon config.yaml settings using the authoritative schema and automatic rollback snapshots.
license: None
---

# OpenTalon configuration

Use the bundled `opentalon-config` command. It validates with the same Zod schema as the running application and never applies a candidate without first saving the current file under `config-snapshots/`.

## Workflow

1. Read the current file with `opentalon-config show`.
2. Inspect relevant schema fields with `opentalon-config schema`, narrowing the JSON with `jq` when useful.
3. Preserve unrelated settings and comments. Write the complete proposed YAML to a temporary candidate file; do not edit `config.yaml` directly.
4. Run `opentalon-config validate <candidate>` and fix every reported error.
5. Summarize consequential behavior changes. Then run `opentalon-config apply <candidate>`. The normal approval boundary for shell commands still applies.
6. Confirm success and report the rollback snapshot named by the command. Most settings hot-reload; restart only when documentation or observed behavior says it is required.

Do not put credentials in `config.yaml`. Use `request_secret` for new credentials, store them in `secrets.yaml`, and reference them as `${secrets.custom.<path>}`. Never print existing secret values.

For HTTP endpoints and authentication rules, use the `opentalon-api` skill.

## Useful schema queries

```bash
opentalon-config schema | jq '.definitions.OpenTalonConfig.properties.tools'
opentalon-config schema | jq '.definitions.OpenTalonConfig.properties.llm'
```
