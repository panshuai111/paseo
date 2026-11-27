# Hermes Feishu for Paseo

View Hermes Feishu conversations in Paseo and guide their running tasks from the
standard message input. Hermes remains responsible for the conversation history
and the original task's reply.

Install this directory as a Paseo directory plugin on the host that runs Hermes.
Run the reader and enrollment process under the same operating-system account
as the two services.

1. Put `read-hermes.py`, `feishu_activity.py`, and `feishu_titles.py` in
   `~/.local/share/paseo-hermes-feishu/`. Put an executable named `read-hermes`
   beside them that runs `read-hermes.py` with the installed Hermes Python
   interpreter. The reader attaches to the existing Hermes gateway.
2. Run `read-hermes` to produce snapshots in
   `~/.local/state/paseo-hermes-feishu/`.
3. Run `sync.mjs` with Node and set `PASEO_SYNC_URL` to the Paseo WebSocket
   endpoint, `PASEO_CLIENT_MODULE` to the installed Paseo client's
   `daemon-client.js`, and `PASEO_PASSWORD` through the service environment if
   required. Set `PASEO_HERMES_AUTO_RESTORE_SINCE` to an ISO timestamp to enable
   restoration on Feishu messages after that time.

The reader and enrollment process are long-running services. Keep their state
directory private because the snapshots contain conversation history.
