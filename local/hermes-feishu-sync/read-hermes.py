"""Publish read-only snapshots from the already running Hermes gateway."""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feishu_activity import FeishuActivity
from feishu_titles import SenderNames, is_reaction_only, session_origins, workspace_title


def write_snapshot(directory, name, value):
    temporary = directory / (name + ".tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(directory / name)


def project(rows):
    items = []
    for row in rows:
        role = row.get("role")
        if role not in ("user", "assistant", "tool"):
            continue
        row_id = row.get("row_id")
        if role == "tool":
            row_id = row.get("tool_call_id") or row_id
            name = row.get("name")
            text = row.get("context")
        else:
            name, text = None, row.get("text")
        if row_id is None or (role != "tool" and not isinstance(text, str)):
            continue
        timestamp = row.get("timestamp")
        items.append({
            "id": f"{role}-{row_id}",
            "role": role,
            "text": (text if isinstance(text, str) else "")[:16000],
            **({"name": name} if isinstance(name, str) else {}),
            **({"timestamp": datetime.fromtimestamp(timestamp, timezone.utc).isoformat()}
               if isinstance(timestamp, (float, int)) else {}),
        })
    return items


async def refresh(gateway, directory, previous, names, activity, timeline_heads):
    live = await gateway.rpc("session.list", scope="live", limit=200)
    stored = await gateway.rpc("session.list", scope="stored", limit=200)
    rows = {
        row["session_id"]: row
        for row in stored["sessions"] + live["sessions"]
        if row.get("source") == "feishu" and re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", row["session_id"])
    }
    sources = await asyncio.to_thread(session_origins, names.hermes_home, tuple(rows))
    names.origins = {
        session_id: sources.get(session_id, names.origins.get(session_id, {}))
        for session_id in rows
    }
    available = []
    for session_id, row in rows.items():
        origin = names.origins[session_id]
        prior = previous.get(session_id)
        reaction_only = prior[-1] if prior else False
        sender = names.name(origin, allow_lookup=not reaction_only)
        title = row.get("title") or ""
        revision = (row.get("message_count", 0), bool(row["running"]), title,
                    workspace_title(origin, sender, title, reaction_only), reaction_only)
        file = directory / (session_id + ".json")
        if prior != revision or row["running"] or not file.exists():
            try:
                snapshot = await gateway.rpc("session.resume", session_id=session_id, display_projection=True)
            except GatewayRPCError as error:
                if str(error) in ("not_found", "permission_denied"):
                    continue
                raise
            try:
                if snapshot["session_id"] != session_id:
                    continue
                messages = snapshot["display_messages"]
                reaction_only = is_reaction_only(messages)
                composed = workspace_title(origin, sender, title, reaction_only)
                items = project(messages)
                write_snapshot(directory, file.name, {
                    "title": title[:110] or "飞书会话 " + session_id[-8:],
                    "workspaceTitle": composed,
                    "running": bool(snapshot["running"]),
                    "authorityEpoch": snapshot.get("authority_epoch"),
                    "executionGeneration": snapshot.get("execution_generation"),
                    "items": items,
                })
                timeline_heads[session_id] = next((
                    item["id"] for item in reversed(items)
                    if item["role"] in ("user", "assistant") and item["text"].strip()
                ), None)
                previous[session_id] = (*revision[:3], composed, reaction_only)
            finally:
                await gateway.rpc("session.detach", session_id=snapshot["session_id"],
                                  subscription_id=snapshot["subscription_id"])
        available.append(session_id)
    await asyncio.to_thread(activity.refresh)
    write_snapshot(directory, "inbound-activity.json", {
        session_id: {
            **activity.latest.get(session_id, {}),
            "timelineHead": timeline_heads.get(session_id),
        }
        for session_id in available
    })
    write_snapshot(directory, "catalog.json", available)


async def run(directory):
    previous = {}
    names = SenderNames(hermes_home, directory)
    activity = FeishuActivity(hermes_home)
    timeline_heads = {}
    while True:
        try:
            result = await asyncio.to_thread(discover_gateway_endpoint, hermes_home)
            if attachable(result):
                async with connect_gateway(endpoint=result.endpoint) as gateway:
                    await asyncio.wait_for(refresh(gateway, directory, previous, names, activity, timeline_heads), timeout=45)
            else:
                print("Hermes gateway unavailable", flush=True)
        except (GatewayClientError, TimeoutError, OSError) as error:
            print("Hermes snapshot read failed:", type(error).__name__, flush=True)
        await asyncio.sleep(4)


async def steer(hermes_home, session_id, epoch, generation, text):
    result = await asyncio.to_thread(discover_gateway_endpoint, hermes_home)
    if not attachable(result):
        return "unavailable"
    try:
        async with connect_gateway(endpoint=result.endpoint) as gateway:
            runtime = await gateway.rpc("runtime.describe", _timeout=3)
            if runtime.get("authority_epoch") != epoch:
                return "stale"
            # The owner compares the generation and its live state under the execution lock.
            ack = await gateway.rpc("session.steer", _timeout=4, session_id=session_id,
                                    execution_generation=generation, text=text)
    except GatewayRPCError as error:
        if str(error) in ("stale_generation", "session_superseded", "not_found"):
            return "stale"
        return "rejected"
    except (GatewayClientError, OSError, TimeoutError):
        return "unknown"
    if (ack.get("status") == "queued" and ack.get("authority_epoch") == epoch
            and ack.get("execution_generation") == generation):
        return "accepted"
    return "rejected" if ack.get("delivered") is False else "unknown"


def steer_request(hermes_home):
    request = json.loads(sys.stdin.buffer.read(131073))
    session_id, epoch, generation, text = (request[key] for key in ("sessionId", "epoch", "generation", "text"))
    if (not isinstance(session_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", session_id)
            or type(epoch) is not int or epoch <= 0 or type(generation) is not int or generation <= 0
            or not isinstance(text, str) or not text.strip() or len(text) > 16000):
        return "rejected"
    return asyncio.run(steer(hermes_home, session_id, epoch, generation, text))


if __name__ == "__main__":
    os.umask(0o077)
    hermes_home = Path.home() / ".hermes"
    hermes_source = hermes_home / "hermes-agent"
    sys.path.insert(0, str(hermes_source))
    from pm.environments import activate_dependencies
    activate_dependencies(hermes_source)
    from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError, connect_gateway
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
    if os.environ.get("PASEO_HERMES_STEER") == "1":
        print(steer_request(hermes_home), flush=True)
        sys.exit(0)
    directory = Path.home() / ".local/state/paseo-hermes-feishu"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    asyncio.run(run(directory))
