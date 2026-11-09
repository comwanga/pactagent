"""Deterministic policy tests; real signature/relay tests live in the acceptance lane."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("strfry-write-policy.py"))
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
PROVIDER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
REQUESTER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
AUTHORITY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
NOW = 1900000000


def request(kind=3921, author=PROVIDER, now=NOW):
    return {"type": "new", "receivedAt": now, "sourceType": "IP4", "sourceInfo": "172.18.0.2",
            "event": {"id": "a" * 64, "pubkey": author, "sig": "b" * 128,
                      "kind": kind, "created_at": now, "tags": [], "content": ""}}


def gift(recipient=PROVIDER, now=NOW):
    req = request(1059, REQUESTER, now)
    req["event"]["tags"] = [["p", recipient], ["expiration", str(now + policy.RETENTION)]]
    return req


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = {"PACTAGENT_RELAY_PROVIDER_AUTHORS": PROVIDER,
                    "PACTAGENT_RELAY_REQUESTER_AUTHORS": REQUESTER,
                    "PACTAGENT_RELAY_AUTHORITY_AUTHORS": AUTHORITY,
                    "PACTAGENT_RELAY_POLICY_STATE": str(Path(self.temp.name) / "policy.sqlite")}
        self.p = policy.Policy(self.env, initialize=True)

    def tearDown(self):
        self.p.db.close()
        self.temp.cleanup()

    def accepts(self, req, now=NOW):
        self.p.evaluate(req, now)

    def rejects(self, req, message=None, now=NOW):
        with self.assertRaisesRegex(policy.Refused, message or ".*"):
            self.p.evaluate(req, now)

    def test_all_supported_kinds(self):
        for kind in policy.LIMITS:
            self.accepts(gift() if kind == 1059 else request(kind, REQUESTER if kind == 7300 else PROVIDER))

    def test_kind_one_and_invalid_kinds(self):
        for kind in (1, 13, 14, 7302, -1, True, "3921", 3921.5, None):
            self.rejects(request(kind), "unsupported event kind")

    def test_role_authorization(self):
        self.accepts(request(30360, REQUESTER))
        self.accepts(request(3921, REQUESTER))
        self.accepts(request(3921, AUTHORITY))
        self.rejects(request(30361, REQUESTER), "author not enrolled")
        self.rejects(request(30400, AUTHORITY), "author not enrolled")
        self.rejects(request(7300, PROVIDER), "author not enrolled")

    def test_unauthorized_author(self):
        self.p.providers.clear()
        self.p.participants.remove(PROVIDER)
        self.rejects(request(), "author not enrolled")

    def test_missing_or_invalid_author(self):
        for author in (None, "", "g" * 64, "f" * 64, []):
            self.rejects(request(author=author))
        req = request()
        del req["event"]["pubkey"]
        self.rejects(req)

    def test_missing_configuration(self):
        for name in ("PROVIDER", "REQUESTER", "AUTHORITY"):
            env = {**self.env, "PACTAGENT_RELAY_" + name + "_AUTHORS": ""}
            with self.assertRaises(policy.Refused):
                policy.Policy(env)

    def test_invalid_configuration_keys(self):
        for value in ("f" * 64, PROVIDER + ",", " " + PROVIDER, "*", ",".join([PROVIDER] * 257)):
            with self.assertRaises(policy.Refused):
                policy.Policy({**self.env, "PACTAGENT_RELAY_PROVIDER_AUTHORS": value})

    def test_invalid_timestamp(self):
        for value in (None, -1, True, 1.1, "1900000000", 2 ** 60):
            req = request()
            req["event"]["created_at"] = value
            self.rejects(req, "timestamp")

    def test_future_timestamp_boundary(self):
        req = request()
        req["event"]["created_at"] += policy.SKEW
        self.accepts(req)
        req["event"]["created_at"] += 1
        self.rejects(req, "future timestamp")

    def test_historical_agreement_recovery(self):
        req = request()
        req["event"]["created_at"] = 1
        self.accepts(req)

    def test_per_kind_exact_size_and_first_byte_overflow(self):
        for kind, limit in policy.LIMITS.items():
            req = gift() if kind == 1059 else request(kind, REQUESTER if kind == 7300 else PROVIDER)
            base = len(json.dumps(req["event"], ensure_ascii=False, separators=(",", ":")).encode())
            req["event"]["content"] = "a" * (limit - base)
            self.accepts(req)
            req["event"]["content"] += "a"
            self.rejects(req, "event too large")

    def test_unicode_and_escaped_size_accounting(self):
        req = request(0)
        req["event"]["content"] = "😀" * 4096
        self.rejects(req, "event too large")
        req["event"]["content"] = "\x00" * 3000
        self.rejects(req, "event too large")

    def test_valid_gift_wrap_and_missing_or_unknown_recipient(self):
        self.accepts(gift())
        for tags in ([], [["p", "f" * 64]], [["p", PROVIDER], ["p", REQUESTER]], [["p", PROVIDER, "extra"]]):
            req = gift()
            req["event"]["tags"] = tags
            self.rejects(req, "recipient")

    def test_expiration_contract_and_economic_evidence(self):
        req = gift()
        for tags in (req["event"]["tags"][:1], req["event"]["tags"] + [["expiration", "1"]],
                     [["p", PROVIDER], ["expiration", str(NOW + policy.RETENTION + 1)]],
                     [["p", PROVIDER], ["expiration", "1"]]):
            mutated = copy.deepcopy(req)
            mutated["event"]["tags"] = tags
            self.rejects(mutated, "expiration")
        self.rejects(gift(now=NOW - policy.RETENTION), now=NOW)
        req = request()
        req["event"]["tags"] = [["expiration", str(NOW + 1)]]
        self.rejects(req, "coordination expiration")

    def test_recipient_rate_boundary_and_window_reset(self):
        for _ in range(12):
            self.accepts(gift())
        self.rejects(gift(), "publication quota")
        self.rejects(gift(now=NOW + 59), "publication quota", NOW + 59)
        self.accepts(gift(now=NOW + 60), NOW + 60)

    def test_multiple_author_spam_cannot_bypass_recipient_limit(self):
        for i in range(12):
            req = gift()
            req["event"]["pubkey"] = (PROVIDER, REQUESTER, AUTHORITY)[i % 3]
            self.accepts(req)
        self.rejects(gift(), "publication quota")

    def test_recipient_byte_budget(self):
        req = gift()
        req["event"]["content"] = "x" * (4 * policy.MIB - 1000)
        for _ in range(4):
            self.accepts(req)
        self.rejects(req, "publication quota")

    def test_global_volume_independent_of_recipient(self):
        self.p.db.execute("INSERT INTO buckets VALUES ('gift',?,120,0)", (NOW,))
        self.p.db.commit()
        self.rejects(gift(REQUESTER), "publication quota")
        self.p.db.execute("UPDATE buckets SET count=0,bytes=?", (64 * policy.MIB,))
        self.p.db.commit()
        self.rejects(gift(), "publication quota")

    def test_coordination_quota(self):
        for _ in range(60):
            self.accepts(request())
        self.rejects(request(), "publication quota")
        self.accepts(request(author=REQUESTER))

    def test_restart_preserves_quotas(self):
        for _ in range(12):
            self.accepts(gift())
        self.p.db.close()
        self.p = policy.Policy(self.env, initialize=True)
        self.rejects(gift(), "publication quota")

    def test_bounded_accounting_and_stale_cleanup(self):
        for i in range(1000):
            self.rejects(gift(f"{i:064x}"))
        self.accepts(gift())
        self.accepts(request())
        self.assertEqual(self.p.db.execute("SELECT count(*) FROM buckets").fetchone()[0], 4)
        self.accepts(gift(now=NOW + 60), NOW + 60)
        self.assertEqual(self.p.db.execute("SELECT count(*) FROM buckets").fetchone()[0], 2)
        self.assertLessEqual(self.p.db.execute("PRAGMA page_count").fetchone()[0], 512)

    def test_storage_budget_persists_and_cannot_overflow(self):
        self.p.db.execute("UPDATE metadata SET charged=?", (policy.STORAGE_BUDGET - 1,))
        self.p.db.commit()
        self.rejects(request(), "storage budget exhausted")
        self.p.db.close()
        self.p = policy.Policy(self.env)
        self.rejects(request(), "storage budget exhausted")
        self.accepts(gift())

    def test_gift_flood_cannot_exhaust_economic_evidence_reserve(self):
        release = NOW + policy.RETENTION + 7200
        self.p.db.execute("INSERT INTO gift_storage VALUES (?,?)", (release, policy.GIFT_STORAGE_BUDGET))
        self.p.db.commit()
        self.rejects(gift(), "gift storage budget exhausted")
        self.accepts(request())
        self.p.db.close()
        self.p = policy.Policy(self.env)
        self.rejects(gift(), "gift storage budget exhausted")
        self.accepts(gift(now=release), release)

    def test_gift_storage_credit_waits_for_retention_skew_and_cron(self):
        self.accepts(gift())
        release, charged = self.p.db.execute("SELECT release,bytes FROM gift_storage").fetchone()
        self.assertGreater(release, NOW + policy.RETENTION + policy.SKEW + 60)
        self.assertGreater(charged, 4096)
        self.assertEqual(self.p.db.execute("SELECT charged FROM metadata").fetchone()[0], 0)
        self.accepts(request(now=release - 1), release - 1)
        self.assertEqual(self.p.db.execute("SELECT count(*) FROM gift_storage").fetchone()[0], 1)
        self.accepts(gift(now=release), release)
        self.assertEqual(self.p.db.execute("SELECT count(*) FROM gift_storage").fetchone()[0], 1)

    def test_exact_legacy_wrap_recovery_is_enrolled_and_never_recycles_storage(self):
        req = gift()
        req["event"]["tags"] = [["p", PROVIDER]]
        self.rejects(req, "expiration")
        self.p.legacy_gifts = {req["event"]["id"]}
        self.accepts(req)
        self.assertEqual(self.p.db.execute("SELECT release FROM gift_storage").fetchone()[0], 9007199254740991)
        req["event"]["id"] = "c" * 64
        self.rejects(req, "expiration")

    def test_invalid_legacy_enrollment_configuration(self):
        for ids in ("*", "f" * 63, ",".join(f"{i:064x}" for i in range(33))):
            with self.assertRaises(policy.Refused):
                policy.Policy({**self.env, "PACTAGENT_RELAY_LEGACY_GIFT_IDS": ids})
    def test_disk_reserve(self):
        with patch.object(policy.shutil, "disk_usage", return_value=shutil_usage(0)):
            self.rejects(gift(), "disk reserve")

    def test_backward_clock_fails_closed(self):
        self.accepts(request())
        self.rejects(request(now=NOW - 1), "clock moved backwards", NOW - 1)

    def test_deleted_or_corrupt_state_never_reinitializes(self):
        self.p.db.close()
        Path(self.env["PACTAGENT_RELAY_POLICY_STATE"]).unlink()
        with self.assertRaises(FileExistsError):
            policy.Policy(self.env, initialize=True)
        Path(self.env["PACTAGENT_RELAY_POLICY_STATE"]).write_bytes(b"corrupt")
        with self.assertRaises(sqlite3.DatabaseError):
            policy.Policy(self.env)
        # tearDown may safely close an already-closed connection.

    def test_unexpected_auth_source_and_event_representations(self):
        cases = [None, [], {**request(), "authed": PROVIDER}, {**request(), "sourceType": "Import"},
                 {**request(), "event": "{}"}, {**request(), "type": "stored"}]
        req = request()
        req["event"]["unexpected"] = "private"
        cases.append(req)
        for req in cases:
            self.rejects(req)

    def test_protocol_consecutive_events_malformed_json_and_no_private_logging(self):
        now = int(policy.time.time())
        good = request(now=now)
        bad = request(1, now=now)
        bad["event"]["id"] = "c" * 64
        marker = "PRIVATE-CONTENTS-MUST-NOT-LOG"
        lines = [json.dumps(good), "{malformed " + marker, json.dumps(bad), json.dumps(good)]
        result = subprocess.run([sys.executable, SPEC.origin], input="\n".join(lines) + "\n",
                                text=True, capture_output=True, env={**os.environ, **self.env}, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r["action"] for r in responses], ["accept", "reject", "reject", "accept"])
        self.assertEqual(responses[2]["id"], "c" * 64)
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_missing_configuration_protocol_rejects_instead_of_crashing(self):
        result = subprocess.run([sys.executable, SPEC.origin], input=json.dumps(request()) + "\n",
                                text=True, capture_output=True, env={**os.environ, **self.env,
                                "PACTAGENT_RELAY_PROVIDER_AUTHORS": ""}, check=True)
        self.assertEqual(json.loads(result.stdout)["action"], "reject")

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(policy.Refused):
            policy.decode('{"type":"new","type":"new"}')

    def test_internal_failure_rolls_back_and_rejects(self):
        self.p.db.execute("DROP TABLE buckets")
        self.p.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            self.accepts(request())


def shutil_usage(free):
    from collections import namedtuple
    return namedtuple("usage", "total used free")(10 ** 12, 0, free)


if __name__ == "__main__":
    unittest.main(verbosity=2)
