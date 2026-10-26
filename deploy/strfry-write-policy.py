#!/usr/bin/env python3
"""Strfry 1.1.3 event-sifter. Stdout is exclusively JSON-lines responses.

Strfry verifies signatures before invoking us. Never accept imports/streams or
use an IP / one-time gift-wrap author as an authorization or quota identity.
"""
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import time

MIB = 1024 * 1024
LIMITS = {0: 16384, 10002: 16384, 30360: 65536, 30361: 65536,
          30400: 65536, 3921: 65536, 7300: 65536, 7301: 65536, 1059: 4 * MIB}
RETENTION = 30 * 86400
SKEW = 60
WINDOW = 60
MAX_AUTHORS = 256
MAX_LINE = 4 * MIB + 8192
STORAGE_BUDGET = 256 * MIB  # Permanent public coordination evidence reserve.
GIFT_STORAGE_BUDGET = 256 * MIB  # Separate rolling reserve for expiring wraps.
STORAGE_SLOT = 3600
DISK_RESERVE = 256 * MIB
HEX = re.compile(r"[0-9a-f]{64}\Z")
SIG = re.compile(r"[0-9a-f]{128}\Z")
ZERO_ID = "0" * 64
FIELDS = {"id", "pubkey", "sig", "created_at", "kind", "tags", "content"}


class Refused(Exception):
    pass


def require(condition, message="blocked: invalid policy request"):
    if not condition:
        raise Refused(message)


def integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def public_key(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        return False
    # Validate an x-only secp256k1 public key, including in configuration.
    prime = 2 ** 256 - 2 ** 32 - 977
    x = int(value, 16)
    y2 = (pow(x, 3, prime) + 7) % prime
    return x < prime and pow(y2, (prime - 1) // 2, prime) == 1


def authors(env, name):
    raw = env.get(name, "")
    require(isinstance(raw, str) and 0 < len(raw) <= MAX_AUTHORS * 65,
            "blocked: policy configuration unavailable")
    keys = raw.split(",")
    require(len(keys) <= MAX_AUTHORS and all(public_key(k) for k in keys),
            "blocked: policy configuration unavailable")
    return set(keys)


def decode(line):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(line, object_pairs_hook=unique,
                      parse_constant=lambda _: require(False))


class Policy:
    def __init__(self, env, initialize=False):
        self.providers = authors(env, "PACTAGENT_RELAY_PROVIDER_AUTHORS")
        self.requesters = authors(env, "PACTAGENT_RELAY_REQUESTER_AUTHORS")
        self.authorities = authors(env, "PACTAGENT_RELAY_AUTHORITY_AUTHORS")
        self.participants = self.providers | self.requesters | self.authorities
        require(len(self.participants) <= MAX_AUTHORS,
                "blocked: policy configuration unavailable")
        self.recipients = self.providers | self.requesters
        legacy = env.get("PACTAGENT_RELAY_LEGACY_GIFT_IDS", "")
        require(isinstance(legacy, str) and len(legacy) <= 32 * 65,
                "blocked: policy configuration unavailable")
        self.legacy_gifts = set(legacy.split(",")) if legacy else set()
        require(len(self.legacy_gifts) <= 32 and all(HEX.fullmatch(k) for k in self.legacy_gifts),
                "blocked: policy configuration unavailable")
        self.path = Path(env.get("PACTAGENT_RELAY_POLICY_STATE",
                                 "/app/strfry-db/pactagent-policy.sqlite"))
        require(self.path.is_absolute(), "blocked: policy configuration unavailable")
        marker = self.path.with_suffix(".initialized")
        if initialize and not self.path.exists():
            # An interrupted initialization or removed state must never reset
            # quotas on restart. Recovery requires an operator, not deletion.
            with marker.open("x", encoding="ascii") as handle:
                handle.write("pactagent-policy-v1\n")
                handle.flush()
                os.fsync(handle.fileno())
            db = sqlite3.connect(self.path)
            try:
                db.executescript("""
                    PRAGMA max_page_count=512;
                    CREATE TABLE metadata (
                        id INTEGER PRIMARY KEY CHECK(id=1),
                        version INTEGER NOT NULL CHECK(version=1),
                        charged INTEGER NOT NULL CHECK(charged>=0),
                        last_time INTEGER NOT NULL CHECK(last_time>=0));
                    INSERT INTO metadata VALUES (1,1,0,0);
                    CREATE TABLE buckets (
                        key TEXT PRIMARY KEY,
                        start INTEGER NOT NULL CHECK(start>=0),
                        count INTEGER NOT NULL CHECK(count>=0),
                        bytes INTEGER NOT NULL CHECK(bytes>=0));
                    CREATE TABLE gift_storage (
                        release INTEGER PRIMARY KEY CHECK(release>=0),
                        bytes INTEGER NOT NULL CHECK(bytes>=0));
                """)
                db.commit()
            finally:
                db.close()
        require(self.path.is_file() and marker.is_file(),
                "blocked: policy state unavailable")
        # mode=rw is essential: missing state must not create an empty database.
        self.db = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True, timeout=2)
        try:
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA max_page_count=512")
            require(self.db.execute("PRAGMA quick_check").fetchone() == ("ok",),
                    "blocked: policy state unavailable")
            self.check_state()
        except Exception:
            self.db.close()
            raise

    def check_state(self):
        rows = self.db.execute("SELECT id,version,charged,last_time FROM metadata LIMIT 2").fetchall()
        require(len(rows) == 1 and rows[0][0:2] == (1, 1)
                and all(integer(x) for x in rows[0][2:])
                and rows[0][2] <= STORAGE_BUDGET,
                "blocked: policy state unavailable")
        # At most 2 aggregate + one participant + one recipient bucket/key.
        buckets = self.db.execute("SELECT key,start,count,bytes FROM buckets LIMIT 515").fetchall()
        require(len(buckets) <= 514, "blocked: policy state unavailable")
        for key, start, count, size in buckets:
            require((key in ("gift", "coord") or
                     (key.startswith(("p:", "a:")) and public_key(key[2:])))
                    and all(integer(x) for x in (start, count, size)),
                    "blocked: policy state unavailable")
        gifts = self.db.execute("SELECT release,bytes FROM gift_storage LIMIT 724").fetchall()
        require(len(gifts) <= 723 and all(integer(t) and integer(b) for t, b in gifts)
                and sum(b for _, b in gifts) <= GIFT_STORAGE_BUDGET,
                "blocked: policy state unavailable")
        return rows[0][2], rows[0][3]

    def evaluate(self, req, now=None):
        now = int(time.time()) if now is None else now
        require(isinstance(req, dict) and req.get("type") == "new")
        require(integer(req.get("receivedAt")) and abs(req["receivedAt"] - now) <= SKEW)
        require(req.get("sourceType") in ("IP4", "IP6")
                and isinstance(req.get("sourceInfo"), str) and len(req["sourceInfo"]) <= 128)
        # AUTH is deliberately disabled in the packaged config; don't invent
        # approval semantics for an unexpected authentication representation.
        require("authed" not in req, "blocked: unsupported authentication")
        event = req.get("event")
        require(isinstance(event, dict) and set(event) == FIELDS)
        require(isinstance(event["id"], str) and HEX.fullmatch(event["id"])
                and public_key(event["pubkey"])
                and isinstance(event["sig"], str) and SIG.fullmatch(event["sig"]))
        kind = event["kind"]
        require(integer(kind) and kind in LIMITS, "blocked: unsupported event kind")
        require(integer(event["created_at"]), "invalid: timestamp")
        require(event["created_at"] <= now + SKEW, "invalid: future timestamp")
        require(isinstance(event["content"], str) and isinstance(event["tags"], list))
        require(len(event["tags"]) <= 256)
        for tag in event["tags"]:
            require(isinstance(tag, list) and 1 <= len(tag) <= 16
                    and all(isinstance(v, str) for v in tag))
        size = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        require(size <= LIMITS[kind], "invalid: event too large")
        expiry = [t for t in event["tags"] if t[0] == "expiration"]
        if kind == 1059:
            recipients = [t for t in event["tags"] if t[0] == "p"]
            require(len(recipients) == 1 and len(recipients[0]) == 2
                    and recipients[0][1] in self.recipients,
                    "blocked: recipient not enrolled")
            legacy_recovery = not expiry and event["id"] in self.legacy_gifts
            require(legacy_recovery or (len(expiry) == 1 and len(expiry[0]) == 2
                    and expiry[0][1] == str(event["created_at"] + RETENTION)
                    and event["created_at"] + RETENTION > now),
                    "blocked: gift wrap expiration required")
            quotas = [("gift", 120, 64 * MIB), ("p:" + recipients[0][1], 12, 16 * MIB)]
        else:
            allowed = (self.providers if kind in (30361, 30400) else
                       self.requesters if kind == 7300 else
                       self.providers | self.requesters if kind in (0, 10002, 30360) else
                       self.participants)
            require(event["pubkey"] in allowed, "blocked: author not enrolled")
            # Never accept time-based deletion of public economic evidence.
            require(not expiry, "blocked: coordination expiration forbidden")
            quotas = [("coord", 240, 8 * MIB), ("a:" + event["pubkey"], 60, 2 * MIB)]
        require(shutil.disk_usage(self.path.parent).free >= DISK_RESERVE + size + 4096,
                "blocked: relay disk reserve")
        # Serialize all quota changes, including across plugin processes or
        # restarts. Charge before accept: ambiguous/lost responses overcount
        # safely. No event contents, IDs, or ephemeral author keys are stored.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            charged, last_time = self.check_state()
            require(now >= last_time, "blocked: policy clock moved backwards")
            charge = size + 4096
            if kind == 1059:
                # Expiration <= receipt + retention + skew. Round accounting
                # UP to the next hour, then wait another minute for native cron.
                # Native cron preserves at most one latest event; the 1 GiB
                # LMDB ceiling has additional headroom for that and indexes.
                self.db.execute("DELETE FROM gift_storage WHERE release <= ?", (now,))
                used = self.db.execute("SELECT coalesce(sum(bytes),0) FROM gift_storage").fetchone()[0]
                require(used + charge <= GIFT_STORAGE_BUDGET,
                        "blocked: gift storage budget exhausted")
                release = (9007199254740991 if legacy_recovery else
                           (now // STORAGE_SLOT + 1) * STORAGE_SLOT + RETENTION + SKEW + 60)
                self.db.execute("INSERT INTO gift_storage VALUES (?,?) ON CONFLICT(release) "
                                "DO UPDATE SET bytes=bytes+excluded.bytes", (release, charge))
            else:
                require(charged + charge <= STORAGE_BUDGET,
                        "blocked: relay storage budget exhausted")
                charged += charge
            self.db.execute("DELETE FROM buckets WHERE start <= ?", (now - WINDOW,))
            # Purge de-enrolled keys without evicting any active enrolled key.
            valid = {"gift", "coord"} | {"p:" + k for k in self.recipients} | {
                "a:" + k for k in self.participants}
            for (key,) in self.db.execute("SELECT key FROM buckets").fetchall():
                if key not in valid:
                    self.db.execute("DELETE FROM buckets WHERE key=?", (key,))
            for key, count_limit, byte_limit in quotas:
                row = self.db.execute("SELECT start,count,bytes FROM buckets WHERE key=?", (key,)).fetchone()
                start, count, total = row or (now, 0, 0)
                require(count + 1 <= count_limit and total + size <= byte_limit,
                        "rate-limited: publication quota")
                self.db.execute("INSERT OR REPLACE INTO buckets VALUES (?,?,?,?)",
                                (key, start, count + 1, total + size))
            self.db.execute("UPDATE metadata SET charged=?,last_time=? WHERE id=1",
                            (charged, now))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise


def main():
    policy = None
    try:
        policy = Policy(os.environ, initialize="--initialize" in sys.argv)
    except Exception:
        print("PactAgent relay policy unavailable; writes disabled", file=sys.stderr)
    if "--initialize" in sys.argv or "--check" in sys.argv:
        return 0 if policy else 1
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return 0
        event_id = ZERO_ID
        try:
            if len(line) > MAX_LINE:
                while line and not line.endswith(b"\n"):
                    line = sys.stdin.buffer.readline(MAX_LINE + 1)
                raise Refused("invalid: oversized policy request")
            req = decode(line)
            if isinstance(req, dict) and isinstance(req.get("event"), dict):
                candidate = req["event"].get("id")
                if isinstance(candidate, str) and HEX.fullmatch(candidate):
                    event_id = candidate
            require(policy is not None, "blocked: policy unavailable")
            policy.evaluate(req)
            response = {"id": event_id, "action": "accept"}
        except Refused as error:
            response = {"id": event_id, "action": "reject", "msg": str(error)}
        except Exception:
            # Do not log parser input, exception text, ciphertext or private data.
            response = {"id": event_id, "action": "reject", "msg": "blocked: policy evaluation failed"}
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    sys.exit(main())
