# C++ Online Backend

Remote compile/run API for the Electron frontend.

## Local

```bash
npm install
npm start
```

API:

- `GET /health`
- `POST /api/run`

```json
{
  "code": "#include <iostream>\nint main(){ std::cout << \"OK\"; }",
  "stdin": "",
  "flags": ""
}
```

## Render

Push this `backend` folder to GitHub and create a Render Web Service with Docker.
Render will use `Dockerfile`, install `g++`, and expose `PORT` automatically.

Optional environment variables:

- `ALLOWED_ORIGIN=*`
- `COMPILE_TIMEOUT_MS=30000`
- `RUN_TIMEOUT_MS=10000`
- `OUTPUT_LIMIT=64000`
