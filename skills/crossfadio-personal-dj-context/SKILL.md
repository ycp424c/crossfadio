# Crossfadio Personal DJ Context

Use this skill when the user wants to build or upload Personal DJ Context from local LifeMesh into Crossfadio.

## Boundary

- Crossfadio does not read LifeMesh directly.
- This skill runs locally, calls the LifeMesh CLI, derives a DJ-specific summary payload, and writes JSON by default.
- Upload is explicit: call `scripts/upload_personal_dj_context.py` after reviewing or selecting a generated payload.
- Never paste Bridge Tokens into chat. Read them from `CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN`.
- Never upload raw LifeMesh bundle JSON, raw slice content, full diary text, account data, addresses, or health details.

## Generate Payload

From the Crossfadio repo root:

```bash
python3 skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py \
  --out /tmp/personal-dj-context.json
```

The builder defaults to:

```bash
lifemesh bundle "<default DJ task>" --source all --sensitivity-cap Private --max-slices 12
```

Useful overrides:

```bash
python3 skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py \
  --task "为今晚的 coding session 生成 AI DJ 上下文" \
  --max-slices 8 \
  --sensitivity-cap Private \
  --out /tmp/personal-dj-context.json
```

For tests or inspection, use an existing LifeMesh bundle:

```bash
python3 skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py \
  --bundle-file /tmp/lifemesh-bundle.json \
  --out /tmp/personal-dj-context.json
```

## Upload Payload

Set a Settings-created Bridge Token and target URL:

```bash
export CROSSFADIO_BASE_URL="https://crossfadio.example"
export CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN="cfdj_ctx_..."
python3 skills/crossfadio-personal-dj-context/scripts/upload_personal_dj_context.py \
  --file /tmp/personal-dj-context.json
```

Local development default:

```bash
CROSSFADIO_BASE_URL=http://127.0.0.1:4318 \
CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN="$TOKEN" \
python3 skills/crossfadio-personal-dj-context/scripts/upload_personal_dj_context.py \
  --file /tmp/personal-dj-context.json
```

## Output Rules

The scripts print only path/status, slice count, retention semantics, and summary-level fields. They do not print raw LifeMesh slice content or the full uploaded payload.
