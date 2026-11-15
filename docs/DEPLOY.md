# Deploying Gauge

There are two ways to run Gauge outside development:

- **Vercel + Render** (the live deployment): the web app on Vercel (`apps/web/vercel.json`), the API, verify service and Postgres on Render through the Blueprint in `render.yaml`.
- **Self-hosted with Docker Compose**, through `docker-compose.prod.yml`.

Both run the same four parts:

| Part | Built from | Listens on | Notes |
| --- | --- | --- | --- |
| web | `apps/web/Dockerfile` (nginx), or Vercel | 80 | Serves the SPA and forwards `/api/*` to the API with the `/api` prefix stripped |
| api | `apps/api/Dockerfile` | 3000, or Render's `PORT` | Runs `prisma migrate deploy` on every start, then `node dist/main.js` |
| verify | `verify/Dockerfile` | 4000 | Layer 2 service: `/extract`, `/lint`, `/verify`, `/health` |
| postgres | `postgres:16-alpine`, or Render Postgres | 5432 | The only stateful part |

The seed is **never** automatic. Run it once by hand, as described below.

## Required environment (api)

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Compose sets `postgresql://gauge:gauge@postgres:5432/gauge`; Render fills it from `gauge-db`. |
| `JWT_SECRET` | yes | At least 32 characters; the API will not start without it. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Render generates it. |
| `VERIFY_SERVICE_URL` | yes | The full URL of the verify service, **with `http://`**. Compose uses `http://verify:4000`. If it is unset, the API falls back to `http://localhost:4000`, which is wrong inside a container. |
| `VERIFY_SERVICE_TOKEN` | yes, when verify is reachable from outside | Shared secret: set the **same** value on the api and on verify. The api sends it as `Authorization: Bearer ...`; verify answers 401 to any POST without it. `GET /health` stays open. Empty on both sides disables the check (local default). Generate one like `JWT_SECRET`. |
| `TRUST_PROXY` | no | Number of reverse-proxy hops in front of the api, so the login/register rate limit (10 attempts per IP per route per minute) sees the client's IP. Compose and `render.yaml` set `1`. Unset, every client behind a proxy shares the proxy's bucket. |
| `PORT` | no | Defaults to 3000. Render sets its own value. |
| `NODE_ENV` | set by the image | `production`. This makes the seed refuse default passwords. |
| `LLM_PROVIDER` | no | Set to `anthropic` for deployments, because neither stack runs Ollama. |
| `ANTHROPIC_API_KEY` | for intake | Without it, intake scoring fails but everything else works. |
| `ANTHROPIC_MODEL` | no | Leave unset to use the default in `apps/api/src/intake/llm/anthropic.provider.ts`. |
| `SEED_ADMIN_PASSWORD`, `SEED_REVIEWER_PASSWORD` | for the seed only | Both must be set, and neither may be a dev default. The seed refuses to run otherwise. |
| `SLACK_WEBHOOK_URL` | no | Leave empty to log alerts instead of sending them. |

`.env.example` lists every variable, with comments.

## Self-host with Docker Compose

`docker-compose.prod.yml` uses its own project name (`gauge-prod`) and its own volume (`gauge-prod_gauge_prod_pgdata`). Its postgres publishes no host port. Together these mean it cannot touch the dev database (project `gauge`, volume `gauge_gauge_pgdata`, port 5432), and the two stacks can run side by side.

1. **Write the secrets to a root `.env`.** Compose reads `.env` next to the compose file for `${...}` substitution. It is gitignored, and dev uses `apps/api/.env`, so the two do not collide. Every compose command needs `JWT_SECRET`, including `ps`, `logs` and `down`, so keep it in this file rather than in a shell export.

   Generate a secret:

   ```sh
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Then create `.env` at the repo root in an editor:

   ```
   JWT_SECRET=<the 96-character hex string>
   VERIFY_SERVICE_TOKEN=<optional; verify is not published by this stack>
   ANTHROPIC_API_KEY=sk-ant-...   # optional; only intake scoring needs it
   ```

2. **Start the stack.**

   ```sh
   docker compose -f docker-compose.prod.yml up -d --build
   ```

   Compose starts postgres and verify first. The api starts once both are healthy: it migrates, then serves. The web starts once the api is healthy. The api counts as healthy only when `/health` reports `"db":"up"`.

3. **Seed once.** `run` goes through the same entrypoint, so it migrates first and then seeds:

   ```sh
   docker compose -f docker-compose.prod.yml run --rm -e SEED_ADMIN_PASSWORD=<strong password> -e SEED_REVIEWER_PASSWORD=<another> api node dist-seed/prisma/seed.js
   ```

   The command is a single line, so it works the same in bash and PowerShell.

   This creates `admin@gauge.local`, `reviewer@gauge.local`, a rubric and a posting.

4. **Open the app** at <http://localhost:8080> (change the port with `WEB_PORT`) and sign in as `admin@gauge.local`.

5. **Check it.**

   ```sh
   curl.exe http://localhost:8080/api/health    # {"status":"ok",...,"db":"up"}  (plain curl in bash)
   docker compose -f docker-compose.prod.yml exec api sh -c 'wget -qO- "$VERIFY_SERVICE_URL/health"'
   ```

To stop the stack, run `docker compose -f docker-compose.prod.yml down`. Add `-v` only if you also want to delete the production database volume.

## Render

`render.yaml` defines three resources, all on the `free` plan; the web app is on Vercel (step 3):

- `gauge-api`, a Docker web service.
- `gauge-verify`, a Docker web service on port 4000.
- `gauge-db`, a Postgres database.

Every plan is set explicitly, because a Blueprint service with no `plan` defaults to the paid `0.5c-512mb`.

1. **Create the Blueprint.** In Render, choose **New → Blueprint**, pick this repository, and confirm. Render asks for every variable marked `sync: false`:
   - **`ANTHROPIC_API_KEY`**: your key.
   - **`VERIFY_SERVICE_URL`**: leave blank for now and set it in step 2.
   - **`VERIFY_SERVICE_TOKEN`**: asked for on **both** `gauge-api` and `gauge-verify`. Enter the same random string on each (generate it as for `JWT_SECRET`). Until it is set on both, the public verify URL accepts calls from anyone; set on only one side, every verify call fails with 401.
   - **`SEED_ADMIN_PASSWORD` and `SEED_REVIEWER_PASSWORD`**: strong passwords. They are used only by the seed.
   - **`SLACK_WEBHOOK_URL`**: optional.

   `JWT_SECRET` is generated for you, and `DATABASE_URL` is filled in from `gauge-db`.

2. **Connect the API to verify.** This step is manual. Copy the public URL of `gauge-verify` and set it on `gauge-api`, with the scheme:

   ```
   VERIFY_SERVICE_URL=https://gauge-verify-xxxx.onrender.com
   ```

   The public URL is used because Render's free web services can send private-network traffic but cannot receive it. On a paid verify instance you could use the internal address (**Connect → Internal**, `http://gauge-verify-xxxx:4000`) instead; it has no scheme, so add `http://`.

3. **Deploy the web app on Vercel.** Import the repository in Vercel with `apps/web` as the root directory. `apps/web/vercel.json` builds it and rewrites `/api/*` to the API's Render URL; if Render assigned the API a different hostname, edit that `destination` and redeploy.

4. **Migrations need no action.** Every API deploy runs `prisma migrate deploy` before it starts.

5. **Seed once.** Pick one of these:
   - **Render Shell on `gauge-api`** (paid instances): run `node dist-seed/prisma/seed.js`. It uses the service's own environment.
   - **From your machine, against the database's External Database URL:**

     ```sh
     docker build -t gauge-api apps/api
     docker run --rm -e DATABASE_URL=<external url> -e SEED_ADMIN_PASSWORD=<...> -e SEED_REVIEWER_PASSWORD=<...> gauge-api node dist-seed/prisma/seed.js
     ```

     This also runs `migrate deploy` first, which is harmless.

6. **Open the Vercel URL** and sign in as `admin@gauge.local`.

**Adding the verify token to the existing services.** Render prompts for `sync: false` values when a Blueprint is created; if it does not prompt on the next sync, add `VERIFY_SERVICE_TOKEN` by hand in each service's **Environment** page. Order matters: deploy the code first, then set the token on `gauge-api`, then on `gauge-verify`. With the token on verify but not yet on the API, every verify call fails with 401; in the order above, verify accepts the API's header before it starts requiring it.

**Free tier.** Free services spin down when idle, so the first request after a pause is slow. The API gives each verify call 5 seconds, so a verify service that is waking up from a free-tier spin-down shows as `not_run` in a preview, not as a slow request. Free Postgres databases are time-limited; check Render's current limits before you rely on one.

**What has been tested.** The Compose stack was built and tested locally. The Vercel + Render deployment is up: on 2026-11-15 the Render API's `/health` answered `{"status":"ok","db":"up"}`. The rest of the live setup (web on Vercel, verify on Render) is as configured in `apps/web/vercel.json` and `render.yaml`, not separately checked.

## Known limits

- **The deployed verify service cannot run submitted CAD code.** `verify/Dockerfile` is the stdlib-only Python image, without `cadquery`. `/verify` therefore falls back to static checks (`static_cad`), which read box size and holes from the source text. It does not execute the reference or measure the solid. `/probe` needs Ollama, which neither stack runs: `POST /tasks/:id/probe` then stores a `NOT_RUN` probe run instead of a tier (compose passes `OLLAMA_BASE_URL` to the verify container, so a host Ollama can be used).
- **CORS is open.** `apps/api/src/main.ts` calls `app.enableCors()` with no options, so any origin may call the API. `WEB_ORIGIN` appears in `.env.example`, but nothing in `apps/api/src` reads it. In both deployments the browser reaches the API through the web origin's `/api` proxy, so the app itself does not need CORS. Restricting it to the web origin is a code change that has not been made.
- **Run the seed once per database.** A second run leaves the two users and their passwords unchanged, but it adds another rubric and another posting.
