# Deploy the Synapse Frontend to Cloudflare (OpenNext → Workers)

The Next.js frontend deploys to **Cloudflare Workers** via the **OpenNext** adapter
(`@opennextjs/cloudflare`). This supports the Node.js runtime (`nodejs_compat`), so the
app's API routes (Supabase admin client, Google Drive token exchange) work unchanged.

Config already in the repo:
- `open-next.config.ts` — OpenNext adapter config
- `wrangler.jsonc` — Worker config (`name: synapse-web`, `nodejs_compat`, assets binding)
- `next.config.ts` — calls `initOpenNextCloudflareForDev()` for local parity
- `package.json` scripts: `cf:build`, `cf:preview`, `cf:deploy`, `cf:typegen`

> Requires Next.js ≥ 16.2.6 (the repo is pinned to `^16.2.9`).

---

## 0) Prerequisites
- A Cloudflare account (you already have one — R2 storage lives there).
- Node 18+ locally.
- Your env values (same as `.env.local`).

---

## 1) Set environment variables / secrets

**Never commit secrets.** Two places to provide them:

**Local preview** — create `.dev.vars` in the repo root (gitignored):
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
NEXT_PUBLIC_GOOGLE_API_KEY=...
NEXT_PUBLIC_APP_URL=http://localhost:3000
BACKEND_API_URL=https://<your-gpu-backend-domain>
```

**Production** — set them in the Cloudflare dashboard after the first deploy:
*Workers & Pages → synapse-web → Settings → Variables and Secrets*. Mark the
service-role key, Google secret, etc. as **encrypted secrets**.

---

## 2) Deploy — Method A: CLI (fastest for the first deploy)

```bash
# Build the Worker bundle:
npm run cf:build

# Preview it locally on the Workers runtime (optional but recommended):
npm run cf:preview        # serves on http://localhost:8787

# Deploy (opens a browser to authorize your Cloudflare account the first time):
npm run cf:deploy
```

After deploy you get a free URL: **`https://synapse-web.<your-subdomain>.workers.dev`** —
shareable immediately (great for a supervisor demo before buying a domain).

Then add your production env vars in the dashboard (step 1) and redeploy.

---

## 2) Deploy — Method B: Git auto-deploy (CI on every push)

1. Cloudflare dashboard → **Workers & Pages → Create → Workers → Import a repository**.
2. Select your GitHub repo (`codera647/synapse`).
3. Build settings:
   - **Build command:** `npx opennextjs-cloudflare build`
   - **Deploy command:** `npx wrangler deploy`
4. Add the environment variables (step 1).
5. Save & deploy. Every push to `master` now auto-builds and deploys.

---

## 3) Custom domain

1. Register the domain on **Cloudflare → Domain Registration → Register Domains**
   (wholesale price, no markup). E.g. `trysynapse.com` or `synapse.chat`.
2. Project → **Settings → Domains & Routes → Add → Custom domain** → enter your domain.
   DNS + SSL are configured automatically because the domain is in the same account.
3. Update env: set `NEXT_PUBLIC_APP_URL=https://yourdomain` and redeploy.

---

## 4) Update Google OAuth (so Drive login keeps working)

In Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add:
```
https://yourdomain/api/google-drive/callback
https://yourdomain/auth/callback
```
And add `https://yourdomain` to **Authorized JavaScript origins**.

---

## 5) Connect to the GPU backend

Set `BACKEND_API_URL` to your backend's HTTPS URL (once you finish the backend's
Caddy + domain step). The frontend proxy at `/api/backend/[...path]` forwards to it,
and set the backend's `FRONTEND_ORIGIN` to your new frontend domain for CORS.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `peer next@... ` install error | Next must be ≥16.2.6 (repo pins `^16.2.9`). |
| API route 500 about a Node API | Ensure `compatibility_flags: ["nodejs_compat"]` is in `wrangler.jsonc`. |
| Env var undefined at runtime | Set it in dashboard Variables (prod) or `.dev.vars` (preview), then redeploy. |
| OAuth redirect mismatch | Add the exact prod callback URLs in Google Console (step 4). |
| Build OOM / slow | `npm run cf:build` runs a full `next build`; give it a minute. |
