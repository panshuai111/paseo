"""Build sidebar titles from the original Hermes session source."""
import asyncio
from contextlib import closing
from hashlib import blake2s
import json
import os
import re
import sqlite3
import subprocess
import time
import unicodedata


REACTION = re.compile(r"reaction:(added|removed):[A-Z0-9_]+")
CONTACT_ID_TYPES = (
    (re.compile(r"ou_[A-Za-z0-9_-]+"), "open_id"),
    (re.compile(r"on_[A-Za-z0-9_-]+"), "union_id"),
)


def label(value, limit):
    if not isinstance(value, str):
        return ""
    value = " ".join("".join(" " if c.isspace() else c for c in value if c.isspace() or unicodedata.category(c)[0] != "C").split())
    if not value or re.fullmatch(r"(?:oc|ou|on|om)_[\w-]+", value):
        return ""
    return value if len(value) <= limit else value[:limit - 1].rstrip() + "…"


def session_origins(hermes_home, session_ids):
    if not session_ids:
        return {}
    placeholders = ",".join("?" for _ in session_ids)
    query = f"SELECT id, origin_json FROM sessions WHERE source = ? AND id IN ({placeholders})"
    uri = (hermes_home / "state.db").as_uri() + "?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=0.3)) as connection:
            rows = connection.execute(query, ("feishu", *session_ids)).fetchall()
    except sqlite3.Error:
        return {}
    origins = {}
    for session_id, raw in rows:
        try:
            origin = json.loads(raw) if raw else None
        except ValueError:
            continue
        if isinstance(origin, dict):
            origins[session_id] = origin
    return origins


def is_reaction_only(rows):
    messages = [row.get("text") for row in rows if row.get("role") == "user"]
    return bool(messages) and all(isinstance(x, str) and REACTION.fullmatch(x.strip()) for x in messages)


def workspace_title(origin, sender_name, topic, reaction_only=False):
    kind = origin.get("chat_type")
    if kind in ("group", "forum"):
        source = label(origin.get("chat_name"), 28) or "飞书群"
    elif kind == "dm":
        source = "私聊"
    else:
        source = "飞书"
    subject = "表情回应" if reaction_only else label(topic, 58) or "飞书会话"
    sender = label(sender_name, 18)
    if not sender and not reaction_only:
        sender_id = origin.get("user_id") or origin.get("user_id_alt")
        if isinstance(sender_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sender_id):
            sender = "ID " + blake2s(sender_id.encode(), digest_size=4).hexdigest()
    return " · ".join(dict.fromkeys(part for part in (source, sender, subject) if part))


class SenderNames:
    def __init__(self, hermes_home, directory):
        self.hermes_home = hermes_home
        self.path = directory / "sender-display-names.json"
        self.pinned = {}
        self.origins = {}
        self.retry_at = {}
        self.pending = {}
        self.limiter = asyncio.Semaphore(2)
        try:
            data = json.loads(self.path.read_text())
            if isinstance(data, dict):
                self.pinned = data
        except (OSError, ValueError):
            pass

    def name(self, origin, allow_lookup=True):
        recorded = label(origin.get("user_name"), 18)
        if recorded:
            return recorded
        if not allow_lookup:
            return ""
        sender = origin.get("user_id")
        if not isinstance(sender, str):
            return ""
        if known := label(self.pinned.get(sender), 18):
            return known
        for pattern, id_type in CONTACT_ID_TYPES:
            if pattern.fullmatch(sender):
                if sender not in self.pending and time.monotonic() >= self.retry_at.get(sender, 0):
                    self.pending[sender] = asyncio.create_task(self.lookup(sender, id_type))
                break
        return ""

    async def lookup(self, sender, id_type):
        try:
            async with self.limiter:
                result = await asyncio.to_thread(self.get_contact, sender, id_type)
            if result:
                self.pinned[sender] = result
                temp = self.path.with_suffix(".tmp")
                temp.write_text(json.dumps(self.pinned, ensure_ascii=False), encoding="utf-8")
                temp.replace(self.path)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        finally:
            self.retry_at[sender] = time.monotonic() + 1800
            self.pending.pop(sender, None)

    def get_contact(self, sender, id_type):
        env = dict(
            os.environ,
            HERMES_HOME=str(self.hermes_home),
            LARKSUITE_CLI_NO_UPDATE_NOTIFIER="1",
            LARKSUITE_CLI_NO_SKILLS_NOTIFIER="1",
        )
        result = subprocess.run(
            [
                str(self.hermes_home / "bin/lark-cli"), "contact", "+get-user",
                "--user-id", sender, "--user-id-type", id_type, "--as", "bot", "--format", "json",
            ],
            env=env, capture_output=True, text=True, timeout=8,
        )
        if result.returncode:
            return ""
        data = json.loads(result.stdout).get("data") or {}
        user = data.get("user") or data
        returned_id = user.get(id_type)
        if returned_id and returned_id != sender:
            return ""
        return label(user.get("name") or user.get("display_name"), 18)
