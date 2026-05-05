# RunPod Backend API

Expose a FastAPI service to provide hardware info to the dashboard.

## Base URL

Set in `.env.local`:

```
NEXT_PUBLIC_RUNPOD_API_URL=https://<pod-id>-8000.proxy.runpod.net
```

## Endpoints

### `GET /hardware`

Returns the auto worker plan:

```
{
  "cpu": 15,
  "ram_gb": 120,
  "vram_gb": 24,
  "gpu": "NVIDIA RTX 5090",
  "sync_workers": 6,
  "extract_workers": 5,
  "embed_workers": 2
}
```
