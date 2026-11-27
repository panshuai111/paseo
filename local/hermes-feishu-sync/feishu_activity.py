"""Read admitted human Feishu messages without changing Hermes state."""
from contextlib import closing
from datetime import datetime, timezone
import json
import re
import sqlite3

from feishu_titles import REACTION


FEISHU_MESSAGE_ID = re.compile(r"om_[A-Za-z0-9_-]+")


def human_message(request_id, payload_json):
    try:
        payload = json.loads(payload_json)
        native = payload["native_text_v1"]
        source = native["source"]
        message_id = native["event"]["message_id"]
        text = payload["text"].strip()
        if (
            source["platform"] != "feishu"
            or source.get("is_bot") is not False
            or not source.get("user_id")
            or "automation" in native
            or request_id != message_id
            or not FEISHU_MESSAGE_ID.fullmatch(message_id)
            or REACTION.fullmatch(text)
            or text == "/card"
            or text.startswith("/card ")
        ):
            return None
        timestamp = datetime.fromisoformat(native["timestamp"])
        return {"id": message_id, "at": timestamp.astimezone(timezone.utc).isoformat()}
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


class FeishuActivity:
    def __init__(self, hermes_home):
        self.uri = (hermes_home / "state.db").as_uri() + "?mode=ro"
        self.last_sequence = 0
        self.latest = {}

    def refresh(self):
        try:
            with closing(sqlite3.connect(self.uri, uri=True, timeout=0.3)) as connection:
                rows = connection.execute(
                    """SELECT seq, target_session_id, request_id, payload_json
                       FROM session_admissions WHERE seq > ? ORDER BY seq""",
                    (self.last_sequence,),
                ).fetchall()
        except sqlite3.Error as error:
            # Preserve the last known activity on timeout or a transient read failure.
            raise OSError("Unable to read the Hermes admission ledger") from error

        for seq, session_id, request_id, payload_json in rows:
            message = human_message(request_id, payload_json)
            if message and session_id:
                previous = self.latest.get(session_id)
                if previous is None or (
                    message["id"] != previous["id"] and message["at"] > previous["at"]
                ):
                    self.latest[session_id] = message
            self.last_sequence = seq
