# GCP Deployment — Synapse Backend on an L4 GPU Instance

This guide deploys the Synapse Python backend (FastAPI API + GPU worker pool) to a
**Google Compute Engine L4 GPU VM**, with the Next.js frontend hosted separately
(Vercel / Amplify / Cloud Run) and Supabase as the database/queue.

Target instance: **`g2-standard-8`** (NVIDIA L4 24 GB, 8 vCPU, 32 GB RAM).
See the architecture notes at the end for why this size.

> Placeholders like `<PROJECT>`, `<ZONE>`, `<BUCKET>` must be replaced with real values.

---

## 0) Prerequisites

- A GCP project with billing enabled (the $300 free-trial credit works, but **GPU quota
  is 0 on a fresh trial** — request an increase first, step 1).
- Supabase project created (URL + service-role key) with the pipeline schema applied
  (see `docs/database-schema.md` and `docs/sync-pipeline-design.md`).
- An S3-compatible bucket: Cloudflare R2 **or** AWS S3. The backend speaks the S3 API via
  `boto3` with a custom `endpoint_url`.
- An OpenAI API key (chat answers are generated via the OpenAI API, not on the GPU).

---

## 1) Request GPU quota (do this first — it can take hours)

Fresh accounts cannot launch GPUs until quota is granted.

1. Console → **IAM & Admin → Quotas**.
2. Filter for **"GPUs (all regions)"** and the L4 quota in your target region
   (e.g. `NVIDIA_L4_GPUS` in `us-central1`).
3. Request an increase to **≥ 1**.
4. If on the free trial and the request is blocked, **upgrade to a full account**
   (you keep the $300 credit; it only lifts trial restrictions).

L4 availability is per-zone. Good zones: `us-central1-a`, `us-west1-a`, `asia-south1-*`.
If a zone reports "resource not available," try another.

---

## 2) Create the VM

Use a **Deep Learning VM** image (CUDA + NVIDIA driver preinstalled) to avoid driver hell.
**Spot** provisioning is strongly recommended — the pipeline is restartable (idempotent
queue jobs), and Spot is ~60–70% cheaper.

```bash
gcloud compute instances create synapse-gpu \
  --project=<PROJECT> \
  --zone=<ZONE> \
  --machine-type=g2-standard-8 \
  --accelerator=type=nvidia-l4,count=1 \
  --image-family=common-cu121-debian-11 \
  --image-project=deeplearning-platform-release \
  --maintenance-policy=TERMINATE \
  --provisioning-model=SPOT \
  --boot-disk-size=120GB \
  --boot-disk-type=pd-balanced \
  --metadata="install-nvidia-driver=True" \
  --tags=synapse-backend
```

> 120 GB disk leaves room for the HF model cache (~25–30 GB across DocLayout-YOLO,
> Qwen2-VL, BGE, Surya) plus working files.

Firewall — only expose what you need. The frontend talks to the backend over HTTPS,
so prefer a reverse proxy (step 7) and keep 8000 closed publicly:

```bash
# SSH from your IP only:
gcloud compute firewall-rules create synapse-ssh \
  --allow=tcp:22 --target-tags=synapse-backend --source-ranges=<YOUR_IP>/32
# HTTPS in (for nginx/Caddy):
gcloud compute firewall-rules create synapse-https \
  --allow=tcp:443,tcp:80 --target-tags=synapse-backend --source-ranges=0.0.0.0/0
```

SSH in:

```bash
gcloud compute ssh synapse-gpu --zone=<ZONE>
```

Confirm the GPU:

```bash
nvidia-smi   # should list an NVIDIA L4
```

---

## 3) Clone the repo + Python env

```bash
sudo mkdir -p /opt/synapse && sudo chown "$USER":"$USER" /opt/synapse
cd /opt/synapse
git clone https://github.com/<YOU>/<REPO>.git .

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

System OCR dependency (Tesseract) for the CPU OCR fallback:

```bash
sudo apt-get update && sudo apt-get install -y tesseract-ocr
```

---

## 4) Install Python dependencies (base + GPU)

```bash
cd /opt/synapse
source .venv/bin/activate

# Base (API + workers, CPU-safe):
pip install -r backend/requirements-base.txt

# torch/torchvision FIRST, matching the host CUDA (cu121 on the cu121 image):
#   (skip if the Deep Learning image already ships a working CUDA torch — verify:)
python -c "import torch; print(torch.__version__, torch.cuda.is_available())" || \
  pip install torch==2.4.* torchvision==0.19.* --index-url https://download.pytorch.org/whl/cu121

# GPU model deps:
pip install -r backend/requirements-gpu.txt
```

Verify CUDA torch sees the L4:

```bash
python -c "import torch; print('cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

---

## 5) Configure backend environment

Store secrets **outside** the repo:

```bash
sudo mkdir -p /etc/synapse
sudo nano /etc/synapse/backend.env
```

Minimum required:

```bash
# --- Supabase ---
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# --- Object storage (R2 or S3) ---
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com    # or https://s3.<region>.amazonaws.com
R2_BUCKET=<bucket-name>
R2_ACCESS_KEY=<access-key>
R2_SECRET_KEY=<secret-key>

# --- Google Drive (sync worker token refresh) ---
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>

# --- Chat (OpenAI API; no GPU) ---
OPENAI_API_KEY=<openai-key>
CHAT_GPT_MODEL=gpt-4o-mini

# --- API / CORS (comma-separated origins allowed) ---
FRONTEND_ORIGIN=https://<your-frontend-domain>,http://localhost:3000

# --- Workers ---
WORKERS_ENABLED=1
HF_HOME=/opt/synapse/.hf-cache

# --- Optional model/device overrides (defaults are sensible for an L4) ---
# EMBED_MODEL=BAAI/bge-large-en-v1.5
# VIS_QWEN_MODEL=Qwen/Qwen2-VL-2B-Instruct   # upgrade to ...-7B-Instruct for richer captions
# LAYOUT_WORKERS=1
# EXTRACT_WORKERS=3
# CAPTION_WORKERS=1
# EMBED_WORKERS=1
```

Warm the model cache (downloads once; avoids a multi-GB stall on first request):

```bash
cd /opt/synapse/backend
HF_HOME=/opt/synapse/.hf-cache python scripts/preload_models.py
```

---

## 6) Run as a systemd service

```bash
sudo cp /opt/synapse/backend/scripts/synapse-backend.service /etc/systemd/system/
# Edit User=/Group= in the unit if your VM's user isn't "ubuntu".
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-backend
sudo systemctl status synapse-backend --no-pager
```

Smoke test locally on the VM:

```bash
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/ready
curl -s http://127.0.0.1:8000/hardware
curl -s http://127.0.0.1:8000/workers/status
```

> The unit runs `uvicorn app:app` from `WorkingDirectory=/opt/synapse/backend`
> (modules use flat imports — do **not** use `backend.app:app`).

---

## 7) HTTPS reverse proxy

Put the API behind HTTPS so the frontend (and browsers) can call it. Caddy is the
fastest path if you have a domain pointing at the VM's external IP:

```bash
sudo apt-get install -y caddy
# /etc/caddy/Caddyfile:
#   api.yourdomain.com {
#       reverse_proxy 127.0.0.1:8000
#   }
sudo systemctl restart caddy
```

(nginx + certbot works equally well; proxy `:443` → `127.0.0.1:8000`.)

---

## 8) Point the frontend at the backend

In the frontend host (Vercel/Amplify/Cloud Run) environment:

```bash
BACKEND_API_URL=https://api.yourdomain.com        # server-side proxy target
NEXT_PUBLIC_SUPABASE_URL=<...>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<...>
SUPABASE_SERVICE_ROLE_KEY=<...>                   # used by the Next.js API routes
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
NEXT_PUBLIC_APP_URL=https://<your-frontend-domain>
```

The frontend's `/api/backend/[...path]` proxy forwards to `BACKEND_API_URL`. Set
`FRONTEND_ORIGIN` on the backend (step 5) to your frontend domain so CORS passes.

---

## 9) Cost control (make $300 last)

- **Spot + stop-when-idle.** GPU bills per-second while running. Ingestion is bursty —
  stop the VM when you're not preprocessing:
  ```bash
  gcloud compute instances stop synapse-gpu --zone=<ZONE>
  gcloud compute instances start synapse-gpu --zone=<ZONE>
  ```
- **Chat needs no GPU.** Answers come from the OpenAI API; query embedding (BGE) runs
  fine on CPU. For a demo you can even run the API on a cheap CPU VM and only spin up the
  L4 to ingest documents.
- At ~\$0.85/hr on-demand (less on Spot), \$300 covers ~350+ active GPU-hours — ample for
  an FYP if you stop when idle.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `torch.cuda.is_available() == False` | Driver not installed; rerun with `install-nvidia-driver=True` or use the Deep Learning image. `nvidia-smi` must work. |
| Service exits immediately | `journalctl -u synapse-backend -e` — usually a missing env var (`/ready` lists what's unset) or wrong `User=`. |
| `ModuleNotFoundError: hardware` | uvicorn launched from the wrong dir. Must run from `backend/` as `app:app`. |
| First request hangs for minutes | Models downloading. Run `scripts/preload_models.py` first. |
| CUDA OOM during captioning | Lower `VIS_QWEN_BATCH`, keep `LAYOUT_WORKERS=1`, or stay on Qwen2-VL-2B. |
| Storage not cleaned on delete | Ensure `/r2/delete-prefix` is reachable (it's served by `pipeline_api.py`) and R2 creds are set. |

---

## Architecture notes — why `g2-standard-8` (L4)

- **L4 24 GB VRAM** fits the whole ingestion stack (Qwen2-VL-2B ~6 GB + Surya + DocLayout-YOLO
  + BGE ≈ 12–14 GB peak) with headroom to later move to **Qwen2-VL-7B**.
- **8 vCPU** matters: layout rasterization (PyMuPDF), Tesseract, and OCR pre/post-processing
  are CPU-bound. Fewer cores bottleneck the GPU you're paying for.
- **32 GB RAM** avoids OOM-kills when several workers load models + buffer large PDFs.
- The chat LLM is an **API call**, so the GPU is needed only for document ingestion.
