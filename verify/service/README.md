# Verify service — HTTP wrapper

The single seam between Layer 1 (NestJS API) and Layer 2 (verification). The API calls this
service instead of importing verification code, so Layer 2 stays a separate deployable.

Runs on `http://127.0.0.1:4000`. For now it only exposes `/health`; the real `/verify`
endpoint arrives with M7/M8.

```bash
python main.py
```
