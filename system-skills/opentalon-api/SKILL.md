---
name: opentalon-api
description: Discover and use OpenTalon's local administrative HTTP API from its live OpenAPI document, including configuration, snapshots, and service operations.
license: None
---

# OpenTalon API

The running instance publishes a Swagger-compatible OpenAPI 3.1 document at:

```text
http://localhost:3000/api/openapi
```

Fetch that document before constructing an API call; it is authoritative for paths, methods, request bodies, and responses. Use `jq` to select only the relevant path so the full document does not consume context.

```bash
curl --fail --silent --show-error http://localhost:3000/api/openapi \
  | jq '.paths["/api/config"]'
```

Administrative routes may require the dashboard Bearer token. Do not read or print `secrets.yaml` to obtain it. Prefer an equivalent built-in tool or `opentalon-config` for config changes. If no safe authenticated mechanism is available, explain the limitation rather than bypassing authentication.

For mutations:

- Read current state first and preserve fields outside the user's request.
- Use documented validation or dry-run operations when available.
- Create a snapshot before changing configuration.
- Do not restart services, cancel work, restore snapshots, delete resources, send messages, or run workflows unless the user's request authorizes that effect.
- Check the HTTP status and response body; never report success from a `curl` invocation that was not run with `--fail`.

Use `/api/config/schema` when only the configuration JSON Schema is needed. Use the `opentalon-config` skill for the safer candidate-validate-snapshot-apply workflow.
