# Deploying Gauge

There are two ways to run Gauge outside development:

- **Render**, through the Blueprint in `render.yaml`.
- **Self-hosted with Docker Compose**, through `docker-compose.prod.yml`.

Both run the same four parts:

| Part | Built from | Listens on | Notes |
| --- | --- | --- | --- |
| web | `apps/web/Dockerfile` (nginx), or a Render static site | 80 | Serves the SPA and forwards `/api/*` to the API with the `/api` prefix stripped |
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

`render.yaml` defines four resources:

- `gauge-web`, a static site.
- `gauge-api`, a Docker web service on the `free` plan.
- `gauge-verify`, a Docker web service on port 4000, on the paid `0.5c-512mb` plan (see step 2).
- `gauge-db`, a Postgres database on the `free` plan.

Every plan is set explicitly, because a Blueprint service with no `plan` defaults to the paid `0.5c-512mb`.

1. **Create the Blueprint.** In Render, choose **New → Blueprint**, pick this repository, and confirm. Render asks for every variable marked `sync: false`:
   - **`ANTHROPIC_API_KEY`**: your key.
   - **`VERIFY_SERVICE_URL`**: leave blank for now and set it in step 2.
   - **`SEED_ADMIN_PASSWORD` and `SEED_REVIEWER_PASSWORD`**: strong passwords. They are used only by the seed.
   - **`SLACK_WEBHOOK_URL`**: optional.

   `JWT_SECRET` is generated for you, and `DATABASE_URL` is filled in from `gauge-db`.

2. **Connect the API to verify.** This step is manual. On the `gauge-verify` page, open **Connect → Internal** and copy its internal address, which has the form `gauge-verify-xxxx:4000`. Then set this on `gauge-api`:

   ```
   VERIFY_SERVICE_URL=http://gauge-verify-xxxx:4000
   ```

   Two details matter:
   - **Include the `http://` scheme.** The internal address has none. `fromService` in a Blueprint also returns only `host:port`, which is why this variable is not wired automatically.
   - **The internal URL needs a paid instance.** Render's free web services can send private-network traffic but cannot receive it, That is why `render.yaml` puts `gauge-verify` on a paid plan. To run verify for free, set its `plan: free` and use its public URL instead: `VERIFY_SERVICE_URL=https://gauge-verify.onrender.com`.

3. **Check the API URL in the static site.** `render.yaml` rewrites `/api/*` to `https://gauge-api.onrender.com/*`. If Render assigned the API a different hostname, edit that `destination` and redeploy `gauge-web`.

4. **Migrations need no action.** Every API deploy runs `prisma migrate deploy` before it starts.

5. **Seed once.** Pick one of these:
   - **Render Shell on `gauge-api`** (paid instances): run `node dist-seed/prisma/seed.js`. It uses the service's own environment.
   - **From your machine, against the database's External Database URL:**

     ```sh
     docker build -t gauge-api apps/api
     docker run --rm -e DATABASE_URL=<external url> -e SEED_ADMIN_PASSWORD=<...> -e SEED_REVIEWER_PASSWORD=<...> gauge-api node dist-seed/prisma/seed.js
     ```

     This also runs `migrate deploy` first, which is harmless.

6. **Open the `gauge-web` URL** and sign in as `admin@gauge.local`.

**Free tier.** Free services spin down when idle, so the first request after a pause is slow. The API gives each verify call 5 seconds, so a verify service that is waking up from a free-tier spin-down shows as `not_run` in a preview, not as a slow request. Free Postgres databases are time-limited; check Render's current limits before you rely on one.

**What has been tested.** The Compose stack was built and tested locally. The Render Blueprint has not been deployed, so this file has only been checked for YAML shape. In particular, the static-site rewrite to an external URL is untested. If Render does not proxy it, the web app's `/api` calls will fail. The app always calls the relative path `/api`, so the fallback would be to serve the web from the nginx image (`apps/web/Dockerfile`) as a Docker web service, with its `proxy_pass` pointed at the API.

## Known limits

- **The deployed verify service cannot run submitted CAD code.** `verify/Dockerfile` is the stdlib-only Python image, without `cadquery`. `/verify` therefore falls back to static checks (`static_cad`), which read box size and holes from the source text. It does not execute the reference or measure the solid. `/probe` needs Ollama, which neither stack runs: `POST /tasks/:id/probe` then stores a `NOT_RUN` probe run instead of a tier (compose passes `OLLAMA_BASE_URL` to the verify container, so a host Ollama can be used).
- **CORS is open.** `apps/api/src/main.ts` calls `app.enableCors()` with no options, so any origin may call the API. `WEB_ORIGIN` appears in `.env.example`, but nothing in `apps/api/src` reads it. In both deployments the browser reaches the API through the web origin's `/api` proxy, so the app itself does not need CORS. Restricting it to the web origin is a code change that has not been made.
- **Run the seed once per database.** A second run leaves the two users and their passwords unchanged, but it adds another rubric and another posting.
