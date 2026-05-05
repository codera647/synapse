# AWS Deployment (Amplify + EC2 GPU + S3 + Supabase)

This doc is written for your chosen architecture:

- Frontend: **AWS Amplify** (Next.js)
- Backend: **AWS EC2 GPU** (FastAPI + worker pool)
- Storage: **AWS S3**
- Database/Auth: **Supabase**

> Notes
> - Commands below assume **Ubuntu 22.04** on EC2.
> - Replace placeholders like `<REGION>` and `<BUCKET>` with your real values.

## 0) Prereqs

- You have a GitHub repo for this project.
- Supabase project is already created (URL + keys).
- You created an S3 bucket.
- You created an IAM user or role with S3 access keys.

## 1) S3 Setup

Create an S3 bucket (example):

- Bucket name: `synapse-prod-bucket`
- Region: `<REGION>` (e.g. `ap-south-1`)

Create IAM policy (bucket-scoped), attach to IAM user:

- `s3:ListBucket` on the bucket ARN
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<BUCKET>/*`

## 2) EC2 GPU Backend

### 2.1 Launch EC2

Recommended starters:

- `g4dn.xlarge` (T4 16GB) = cheapest usable GPU
- `g5.xlarge` (A10G 24GB) = better

Security Group inbound:

- `22` from your IP only
- `80` and `443` (public) if you will add HTTPS via nginx
- `8000` (optional, for initial testing only)

### 2.2 Install system packages

SSH into EC2:

```bash
ssh -i <KEYPAIR.pem> ubuntu@<EC2_PUBLIC_IP>
```

Install packages:

```bash
sudo apt-get update
sudo apt-get install -y git python3-venv python3-pip nginx
```

### 2.3 Clone repo + venv

```bash
sudo mkdir -p /opt/synapse
sudo chown ubuntu:ubuntu /opt/synapse

cd /opt/synapse
git clone https://github.com/<YOU>/<REPO>.git .

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r backend/requirements.txt
```

### 2.4 Install GPU libs (PyTorch + your models)

Install **torch** with the right CUDA build for your instance/AMI.

Example (CUDA 12.1 wheels):

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

Then install your model deps (examples):

```bash
pip install doclayout-yolo surya-ocr
```

> If you hit CUDA / driver mismatches, use an AWS Deep Learning AMI, or install the NVIDIA driver + CUDA toolkit first.

### 2.5 Configure backend env

Create `/etc/synapse/backend.env`:

```bash
sudo mkdir -p /etc/synapse
sudo nano /etc/synapse/backend.env
```

Minimum required env vars:

```bash
SUPABASE_URL=<your supabase url>
SUPABASE_SERVICE_ROLE_KEY=<service role key>

OPENAI_API_KEY=<your key>  # if chat enabled

# S3
R2_ENDPOINT=https://s3.<REGION>.amazonaws.com
R2_BUCKET=<your bucket>
R2_ACCESS_KEY=<iam access key>
R2_SECRET_KEY=<iam secret key>

FRONTEND_ORIGIN=https://<your-amplify-domain>
WORKERS_ENABLED=1
```

### 2.6 systemd service

Copy the unit file:

```bash
sudo cp /opt/synapse/backend/scripts/synapse-backend.service /etc/systemd/system/synapse-backend.service
sudo systemctl daemon-reload
sudo systemctl enable synapse-backend
sudo systemctl start synapse-backend
sudo systemctl status synapse-backend --no-pager
```

Test:

```bash
curl -sS http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8000/hardware
```

### 2.7 Add HTTPS (nginx)

Proxy `https://<domain>` -> `http://127.0.0.1:8000`.

Use Let’s Encrypt (certbot) if you have a domain pointing to the EC2 public IP.

## 3) Amplify Frontend

1. In AWS Amplify console: **New app -> Host web app -> GitHub**
2. Select repo + branch.
3. Set environment variables in Amplify:

```bash
NEXT_PUBLIC_SUPABASE_URL=<...>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<...>
BACKEND_API_URL=https://<your-ec2-domain>
```

4. Deploy.

## 4) Cutover from R2 to S3

Your backend already uses `boto3` with an `endpoint_url` + `Bucket/Key`.
For S3, set `R2_ENDPOINT` to the region endpoint and keep the rest the same.

## 5) What secrets you need

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- S3: `R2_BUCKET`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_ENDPOINT`
- OpenAI: `OPENAI_API_KEY` (if chat enabled)

