"""Offline tests: python3 -m unittest discover -s tests"""

import csv
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cdr_voip_check as cvc  # noqa: E402
from carriers import HIGH, LOW, MEDIUM, NA, REVIEW, classify_carrier  # noqa: E402


class Normalize(unittest.TestCase):
    def test_us_formats(self):
        for raw in ["6502002345", "(650) 200-2345", "+1 650-200-2345", "16502002345", "650.200.2345",
                    "sip:+16502002345@gw.example.com;user=phone", "tel:+16502002345", "6502002345.0",
                    "6.502002345E+09"]:
            self.assertEqual(cvc.normalize(raw), ("us", "+16502002345"), raw)

    def test_rejects(self):
        for raw in ["", "anonymous", "1699999999", "2026-11-01 10:00:00", "12345", "0502002345",
                    "6501112345", "nan"]:
            self.assertEqual(cvc.normalize(raw)[0], None, raw)

    def test_international(self):
        self.assertEqual(cvc.normalize("+442071234567"), ("intl", "+442071234567"))
        self.assertEqual(cvc.normalize("011442071234567"), ("intl", "+442071234567"))


class Carriers(unittest.TestCase):
    def test_rules(self):
        cases = [
            ("BANDWIDTH.COM CLEC, LLC - CA", "C", HIGH),
            ("ONVOY, LLC - CA", "C", HIGH),
            ("TWILIO INTERNATIONAL, INC.", "C", HIGH),
            ("LEVEL 3 COMMUNICATIONS, LLC - CA", "C", MEDIUM),
            ("VONAGE AMERICA LLC", "C", MEDIUM),
            ("COMCAST PHONE OF CALIFORNIA, LLC", "C", LOW),
            ("TWC IP ENABLED SERVICES, LLC", "C", LOW),
            ("CELLCO PARTNERSHIP DBA VERIZON WIRELESS - CA", "W", LOW),
            ("PACIFIC BELL", "I", LOW),
            ("SOME NEW TELECOM LLC", "C", REVIEW),
        ]
        for name, t, risk in cases:
            self.assertEqual(classify_carrier(name, t)[1], risk, name)
        self.assertEqual(classify_carrier("CELLCO PARTNERSHIP DBA VERIZON WIRELESS", "W")[0], "Mobile")


def _write_csv(path, rows, delim=","):
    with open(path, "w", newline="") as f:
        csv.writer(f, delimiter=delim).writerows(rows)


class Detection(unittest.TestCase):
    def test_header_and_lrn(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.csv"
            _write_csv(p, [["call_id", "start_time", "calling_number", "called_number", "duration", "lrn"]]
                       + [[str(2000000000 + i), "2026-11-01 10:00:00", "6502002345", "6502095123", "30",
                           "6502032000"] for i in range(20)])
            c = cvc.CDR(p)
            self.assertTrue(c.has_header)
            self.assertEqual([c.header[i] for i in c.phone_cols], ["calling_number", "called_number"])
            self.assertEqual({c.header[k]: c.header[v] for k, v in c.lrn_pairs.items()},
                             {"called_number": "lrn"})

    def test_headerless_pipe(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "b.txt"
            _write_csv(p, [["2026-11-01 10:00:00", "6502002345", "+16502095123", "30"]] * 20, delim="|")
            c = cvc.CDR(p)
            self.assertFalse(c.has_header)
            self.assertEqual(c.phone_cols, [1, 2])


class FakeDB:
    BLOCKS = {
        "+16502002345": {"ocn": "506J", "carrier": "TWILIO INTERNATIONAL, INC.", "type": "C"},
        "+16502095123": {"ocn": "394L", "carrier": "COMCAST PHONE OF CALIFORNIA, LLC", "type": "C"},
        "+16502032000": {"ocn": "649C", "carrier": "ONVOY, LLC - CA", "type": "C"},
    }

    def lookup(self, num):
        b = self.BLOCKS.get(num)
        return dict(b, region="CA", rate_center="X") if b else None


def _stats(**nums):
    return {n: {"calls": 1, "cols": {"a"}, "lrn": lrn} for n, lrn in nums.items()}


class Classify(unittest.TestCase):
    def test_block_and_lrn(self):
        res = {r["number"]: r for r in cvc.classify_numbers(
            {"+16502002345": {"calls": 3, "cols": {"a"}, "lrn": None},
             "+16502095123": {"calls": 1, "cols": {"b"}, "lrn": "+16502032000"},
             "+18005551212": {"calls": 1, "cols": {"b"}, "lrn": None},
             "+16509990000": {"calls": 1, "cols": {"b"}, "lrn": None}}, FakeDB())}
        self.assertEqual(res["+16502002345"]["risk"], HIGH)
        self.assertEqual(res["+16502095123"]["risk"], HIGH)  # Comcast block, ported to Onvoy via LRN
        self.assertTrue(res["+16502095123"]["ported"].startswith("yes"))
        self.assertEqual(res["+18005551212"]["risk"], NA)
        self.assertEqual(res["+16509990000"]["risk"], REVIEW)

    def test_twilio_overrides_block(self):
        stats = {"+16502002345": {"calls": 1, "cols": {"a"}, "lrn": None}}
        tw = {"+16502002345": {"type": "mobile", "carrier": "T-Mobile USA, Inc.", "error": None}}
        r = cvc.classify_numbers(stats, FakeDB(), tw)[0]
        self.assertEqual((r["risk"], r["source"]), (LOW, "Twilio line type"))
        self.assertIn("likely", r["ported"])


class TwilioClient(unittest.TestCase):
    def test_lookup_parses_and_caches(self):
        body = {"valid": True, "line_type_intelligence": {"type": "nonFixedVoip", "carrier_name": "Google (Grand Central)",
                                                          "error_code": None}}
        resp = mock.MagicMock()
        resp.__enter__.return_value = io.BytesIO(json.dumps(body).encode())
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict("os.environ", {"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t"}), \
                mock.patch("urllib.request.urlopen", return_value=resp) as uo:
            out = cvc.Twilio(d).lookup_many(["+16502002345"])
            self.assertEqual(out["+16502002345"]["type"], "nonFixedVoip")
            req = uo.call_args[0][0]
            self.assertIn("Fields=line_type_intelligence", req.full_url)
            self.assertTrue(req.get_header("Authorization").startswith("Basic "))
            # second run hits the cache, no new request
            uo.reset_mock()
            cvc.Twilio(d).lookup_many(["+16502002345"])
            uo.assert_not_called()


class LcgParse(unittest.TestCase):
    def test_parse(self):
        xml = (b'<?xml version="1.0"?><!DOCTYPE root [<!ENTITY nbsp "&#x000A0;">]><root><prefixdata>'
               b'<npa>650</npa><nxx>200</nxx><x>2</x><ocn>506J</ocn><company-name>TWILIO&nbsp;INTERNATIONAL, '
               b'INC.</company-name><company-type>C</company-type><region>CA</region><rc>San Mateo</rc>'
               b'</prefixdata></root>')
        rows = cvc._parse_lcg_xml(xml)
        self.assertEqual(rows[0][:5], ["200", "2", "506J", "TWILIO INTERNATIONAL, INC.", "C"])


if __name__ == "__main__":
    unittest.main()
