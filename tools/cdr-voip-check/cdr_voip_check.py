#!/usr/bin/env python3
"""Flag VoIP numbers in US call detail records (CDRs).

Usage:
  python3 cdr_voip_check.py CDR_FILE [CDR_FILE ...] -o OUT_DIR [--twilio]

Steps:
  1. Read CSV / TSV / TXT / XLSX CDRs (with or without a header row).
  2. Find the phone-number columns, normalize to +1XXXXXXXXXX, dedupe.
  3. Free pass: look up each number's block (NPA-NXX-X) in public NANP
     assignment data -> block-holder carrier -> risk (see carriers.py).
     Port-aware only when the CDR carries an LRN column.
  4. Optional paid pass (--twilio): Twilio Lookup Line Type Intelligence,
     which knows ported numbers and returns fixed vs non-fixed VoIP.
  5. Write results.xlsx (summary, VoIP list, all numbers, unknown carriers)
     and an annotated copy of the CDR.
"""

import argparse
import base64
import collections
import concurrent.futures
import csv
import datetime as dt
import html.entities
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from carriers import HIGH, LOW, MEDIUM, NA, REVIEW, TWILIO_TYPES, classify_carrier  # noqa: E402

USER_AGENT = "cdr-voip-check/1.0"
LCG_URL = "https://localcallingguide.com/xmlprefix.php?npa={npa}"
TWILIO_URL = "https://lookups.twilio.com/v2/PhoneNumbers/{num}?Fields=line_type_intelligence"
RISK_ORDER = {HIGH: 0, MEDIUM: 1, REVIEW: 2, LOW: 3, NA: 4}

TOLL_FREE = {"800", "833", "844", "855", "866", "877", "888"}
NON_GEOGRAPHIC = {"500", "521", "522", "523", "524", "525", "526", "527", "528", "529",
                  "533", "544", "566", "577", "588", "600", "700", "710", "900"}

PLACEHOLDERS = {"nan", "none", "null", "anonymous", "restricted", "unknown", "unavailable", "private", "0"}

PHONE_NAME_HINT = re.compile(
    r"ani|dnis|calling|called|caller|callee|from|\bto\b|_to\b|^to|src|dst|orig|term|"
    r"number|phone|\bcli\b|\bcld\b|did|msisdn|a_?num|b_?num|cgpn|cdpn|dialed|dest", re.I)
NOT_PHONE_NAME = re.compile(
    r"\bid\b|_id\b|uuid|time|date|duration|secs?\b|seconds|seq|cost|rate|price|charge|"
    r"bytes|count|code\b|status|ip\b|port", re.I)
LRN_NAME = re.compile(r"lrn|routing.?num", re.I)
CALLED_NAME = re.compile(r"called|dnis|dst|dest|\bto\b|_to\b|^to|cld|cdpn|b_?num|term", re.I)


# --------------------------------------------------------------------------- numbers

def normalize(value):
    """Return ('us', '+1NXXNXXXXXX') | ('intl', raw) | (None, None)."""
    if value is None:
        return None, None
    s = str(value).strip().strip('"').strip()
    if not s or s.lower() in PLACEHOLDERS:
        return None, None
    if re.fullmatch(r"\d+\.0+", s):  # Excel float
        s = s.split(".")[0]
    elif re.fullmatch(r"\d(\.\d+)?[eE]\+?\d+", s):  # scientific notation
        try:
            s = str(int(float(s)))
        except ValueError:
            return None, None
    s = re.sub(r"^(sips?|tel):", "", s, flags=re.I).split("@", 1)[0].split(";", 1)[0]
    if re.search(r"[A-Za-z]", s):  # names, UUIDs, "MNS.18885551234.BL" etc. are not phone numbers
        return None, None
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    elif len(digits) == 10 and not plus:
        pass
    elif digits.startswith("011") and len(digits) >= 11:
        return "intl", "+" + digits[3:]
    elif plus and 8 <= len(digits) <= 15:
        return "intl", "+" + digits
    else:
        return None, None
    if len(digits) != 10:
        return None, None
    npa, nxx = digits[:3], digits[3:6]
    if npa[0] in "01" or nxx[0] in "01" or npa[1:] == "11" or nxx[1:] == "11":
        return None, None
    return "us", "+1" + digits


# --------------------------------------------------------------------------- CDR reading

def _sniff_delimiter(path):
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        sample = f.read(65536)
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return "\t" if sample.count("\t") > sample.count(",") else ","


def _iter_rows(path):
    """Yield lists of strings for every row in a CDR file (all sheets for Excel)."""
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xlsm", ".xls"):
        import pandas as pd
        sheets = pd.read_excel(path, sheet_name=None, header=None, dtype=str)
        for df in sheets.values():
            for row in df.itertuples(index=False):
                yield ["" if (v is None or (isinstance(v, float) and v != v)) else str(v) for v in row]
        return
    delim = _sniff_delimiter(path)
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        for row in csv.reader(f, delimiter=delim):
            yield row


def _is_valid_us(v):
    return normalize(v)[0] == "us"


class CDR:
    """A CDR file: header detection + phone column detection."""

    def __init__(self, path, sample_rows=3000, forced_cols=None, forced_lrn=None):
        self.path = Path(path)
        sample = []
        for i, row in enumerate(_iter_rows(self.path)):
            sample.append(row)
            if i >= sample_rows:
                break
        if not sample:
            raise SystemExit(f"{path}: file is empty")
        first = sample[0]
        rest = sample[1:] or sample
        has_phone_first = any(_is_valid_us(v) for v in first)
        has_phone_rest = any(_is_valid_us(v) for r in rest[:50] for v in r)
        self.has_header = (not has_phone_first) and has_phone_rest
        width = max(len(r) for r in sample)
        if self.has_header:
            self.header = [h.strip() or f"col{i + 1}" for i, h in enumerate(first)]
            self.header += [f"col{i + 1}" for i in range(len(self.header), width)]
            data = sample[1:]
        else:
            self.header = [f"col{i + 1}" for i in range(width)]
            data = sample
        self.width = len(self.header)
        self.phone_cols, self.col_scores = self._detect_phone_cols(data, forced_cols)
        self.lrn_pairs = self._detect_lrn(data, forced_lrn)

    def _col_index(self, name):
        if name in self.header:
            return self.header.index(name)
        if re.fullmatch(r"\d+", name):
            return int(name) - 1
        raise SystemExit(f"{self.path}: no column '{name}'. Columns: {self.header}")

    def _detect_phone_cols(self, data, forced):
        scores = {}
        for i, name in enumerate(self.header):
            vals = [r[i] for r in data if i < len(r) and str(r[i]).strip()]
            if not vals:
                continue
            ok = sum(1 for v in vals if normalize(v)[0] in ("us", "intl"))
            scores[name] = round(ok / len(vals), 3)
        if forced:
            return [self._col_index(c) for c in forced], scores
        cols = []
        for i, name in enumerate(self.header):
            sc = scores.get(name, 0)
            if LRN_NAME.search(name):
                continue
            hinted = bool(PHONE_NAME_HINT.search(name))
            blocked = bool(NOT_PHONE_NAME.search(name)) and not hinted
            if blocked:
                continue
            if sc >= 0.6 or (hinted and sc >= 0.3):
                cols.append(i)
        return cols, scores

    def _detect_lrn(self, data, forced):
        """Return {number_col_index: lrn_col_index}."""
        if forced:
            pairs = {}
            for spec in forced:
                lrn, _, num = spec.partition(":")
                pairs[self._col_index(num)] = self._col_index(lrn)
            return pairs
        if not self.has_header:
            return {}
        lrn_cols = [i for i, n in enumerate(self.header) if LRN_NAME.search(n)]
        called = [i for i in self.phone_cols if CALLED_NAME.search(self.header[i])]
        if len(lrn_cols) == 1 and len(called) == 1:
            return {called[0]: lrn_cols[0]}
        return {}

    def rows(self):
        it = _iter_rows(self.path)
        if self.has_header:
            next(it, None)
        yield from it


# --------------------------------------------------------------------------- block data

def _parse_lcg_xml(raw):
    text = raw.decode("utf-8", "replace")
    start = text.find("<root>")
    if start < 0:
        raise ValueError("unexpected response (no <root>)")
    text = text[start:]

    def ent(m):
        name = m.group(1)
        if name in ("amp", "lt", "gt", "quot", "apos"):
            return m.group(0)
        cp = html.entities.name2codepoint.get(name)
        return chr(cp) if cp else ""

    text = re.sub(r"&([A-Za-z][A-Za-z0-9]*);", ent, text)
    root = ET.fromstring(text)
    rows = []
    for p in root.iter("prefixdata"):
        d = {c.tag: (c.text or "").strip() for c in p}
        rows.append([d.get("nxx", ""), d.get("x", ""), d.get("ocn", ""),
                     re.sub(r"\s+", " ", d.get("company-name", "")).strip(),
                     d.get("company-type", ""), d.get("region", ""), d.get("rc", "")])
    return rows


class PrefixDB:
    """Block-holder lookup by NPA-NXX-X, cached per area code."""

    def __init__(self, cache_dir, offline=False, max_age_days=30, delay=0.5):
        self.dir = Path(cache_dir) / "npa"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.offline = offline
        self.max_age = dt.timedelta(days=max_age_days)
        self.delay = delay
        self.tables = {}
        self.failed = set()

    def _fetch(self, npa):
        url = LCG_URL.format(npa=npa)
        last = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return _parse_lcg_xml(r.read())
            except Exception as e:  # network / parse
                last = e
                time.sleep(2 ** attempt)
        raise RuntimeError(f"area code {npa}: {last}")

    def load(self, npa):
        if npa in self.tables:
            return self.tables[npa]
        f = self.dir / f"{npa}.json"
        data = None
        if f.exists():
            data = json.loads(f.read_text())
            age = dt.datetime.now() - dt.datetime.fromisoformat(data["fetched"])
            if age > self.max_age and not self.offline:
                data = None
        if data is None and not self.offline and npa not in self.failed:
            try:
                rows = self._fetch(npa)
                data = {"fetched": dt.datetime.now().isoformat(timespec="seconds"), "rows": rows}
                f.write_text(json.dumps(data))
                time.sleep(self.delay)
            except RuntimeError as e:
                print(f"  ! {e}", file=sys.stderr)
                self.failed.add(npa)
        table = {}
        for nxx, x, ocn, name, ctype, region, rc in (data or {}).get("rows", []):
            table[(nxx, x)] = {"ocn": ocn, "carrier": name, "type": ctype, "region": region, "rate_center": rc}
        self.tables[npa] = table
        return table

    def lookup(self, e164):
        d = e164[2:]
        npa, nxx, x = d[:3], d[3:6], d[6]
        t = self.load(npa)
        return t.get((nxx, x)) or t.get((nxx, "A"))


# --------------------------------------------------------------------------- Twilio

class Twilio:
    """Twilio Lookup v2 line_type_intelligence with an on-disk cache."""

    def __init__(self, cache_dir, workers=8):
        self.cache_file = Path(cache_dir) / "twilio.jsonl"
        self.cache = {}
        if self.cache_file.exists():
            for line in self.cache_file.read_text().splitlines():
                if line.strip():
                    rec = json.loads(line)
                    self.cache[rec["number"]] = rec
        self.workers = workers
        self.lock = threading.Lock()
        sid, tok = os.environ.get("TWILIO_ACCOUNT_SID"), os.environ.get("TWILIO_AUTH_TOKEN")
        # Without env creds, rely on the network proxy to inject saved credentials.
        self.auth = ("Basic " + base64.b64encode(f"{sid}:{tok}".encode()).decode()) if sid and tok else None

    def _one(self, num):
        url = TWILIO_URL.format(num=urllib.parse.quote(num))
        headers = {"User-Agent": USER_AGENT}
        if self.auth:
            headers["Authorization"] = self.auth
        for attempt in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                    body = json.loads(r.read())
                lti = body.get("line_type_intelligence") or {}
                return {"number": num, "type": lti.get("type"), "carrier": lti.get("carrier_name"),
                        "error": lti.get("error_code"), "valid": body.get("valid")}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    raise SystemExit("Twilio refused the credentials (HTTP %d)." % e.code)
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** attempt)
                    continue
                return {"number": num, "type": None, "carrier": None, "error": f"HTTP {e.code}"}
            except (urllib.error.URLError, TimeoutError):
                time.sleep(2 ** attempt)
        return {"number": num, "type": None, "carrier": None, "error": "network"}

    def lookup_many(self, numbers, limit=None):
        todo = [n for n in numbers if n not in self.cache]
        cached = len(numbers) - len(todo)
        if limit is not None:
            todo = todo[:limit]
        print(f"  Twilio: {cached} cached, {len(todo)} to look up "
              f"(approx ${len(todo) * 0.008:,.2f} at ~$0.008 each; check current pricing)")
        done = 0
        with open(self.cache_file, "a") as out, \
                concurrent.futures.ThreadPoolExecutor(self.workers) as ex:
            for rec in ex.map(self._one, todo):
                with self.lock:
                    self.cache[rec["number"]] = rec
                    if rec.get("error") != "network":
                        out.write(json.dumps(rec) + "\n")
                    done += 1
                    if done % 500 == 0:
                        out.flush()
                        print(f"    {done}/{len(todo)}")
        return {n: self.cache.get(n) for n in numbers}


# --------------------------------------------------------------------------- classify

def classify_numbers(stats, prefix_db, twilio_results=None):
    """stats: {e164: {...counts, lrn}} -> list of result dicts."""
    out = []
    for num, st in stats.items():
        npa = num[2:5]
        res = {"number": num, "calls": st["calls"], "as_columns": ", ".join(sorted(st["cols"])),
               "risk": REVIEW, "class": "", "carrier": "", "carrier_type": "", "ocn": "",
               "region": "", "rate_center": "", "source": "", "ported": "", "note": ""}
        if npa in TOLL_FREE:
            res.update(risk=NA, **{"class": "Toll-free"}, source="number format")
        elif npa in NON_GEOGRAPHIC:
            res.update(risk=NA, **{"class": "Non-geographic / special"}, source="number format")
        else:
            lrn = st.get("lrn")
            key = lrn if lrn and lrn != num else num
            blk = prefix_db.lookup(key)
            if lrn and lrn != num:
                res["ported"] = "yes (LRN " + lrn + ")"
            if blk:
                cls, risk = classify_carrier(blk["carrier"], blk["type"])
                res.update(risk=risk, carrier=blk["carrier"], carrier_type=blk["type"], ocn=blk["ocn"],
                           region=blk["region"], rate_center=blk["rate_center"],
                           source="LRN block holder" if key != num else "block holder (original carrier)")
                res["class"] = cls
            else:
                res.update(risk=REVIEW, **{"class": "Block not found"}, source="block data")
        tw = (twilio_results or {}).get(num)
        if tw and tw.get("type") in TWILIO_TYPES:
            cls, risk = TWILIO_TYPES[tw["type"]]
            if res["carrier"] and tw.get("carrier") and res["source"].startswith("block") \
                    and not _same_company(tw["carrier"], res["carrier"]):
                res["ported"] = res["ported"] or "likely (carrier differs from block holder)"
            res["note"] = f"block holder: {res['carrier']}" if res["carrier"] else ""
            res.update(risk=risk, carrier=tw.get("carrier") or res["carrier"], source="Twilio line type")
            res["class"] = cls
        elif tw and tw.get("error"):
            res["note"] = f"Twilio: {tw['error']}"
        out.append(res)
    out.sort(key=lambda r: (RISK_ORDER.get(r["risk"], 9), -r["calls"], r["number"]))
    return out


_GENERIC = {"LLC", "INC", "CORP", "CO", "LP", "COMMUNICATIONS", "TELECOM", "DBA", "THE", "OF", "CLEC",
            "NETWORK", "NETWORKS", "SERVICES", "TELEPHONE", "COMPANY", "USA", "PCS", "PARTNERSHIP",
            "WIRELESS", "MOBILE", "INTERNATIONAL", "PHONE", "CABLE", "LIMITED", "LTD"}


def _name_tokens(s):
    return {t for t in re.sub(r"[^A-Z0-9 ]", " ", (s or "").upper()).split()
            if len(t) >= 3 and t not in _GENERIC}


def _same_company(a, b):
    return bool(_name_tokens(a) & _name_tokens(b))


# --------------------------------------------------------------------------- output

SUMMARY_HEADINGS = {"CDR VOIP CHECK", "RISK", "BREAKDOWN", "TOP HIGH-RISK CARRIERS", "COLUMNS USED", "NOTE"}
RESULT_COLS = ["number", "risk", "class", "carrier", "carrier_type", "ocn", "region", "rate_center",
               "calls", "as_columns", "source", "ported", "note"]


def write_outputs(out_dir, results, intl, summary, cdrs, row_risk_lookup):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    out_dir.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    bold = Font(bold=True)
    for row in summary:
        ws.append(row)
        if row and row[0] in SUMMARY_HEADINGS:
            for c in ws[ws.max_row]:
                c.font = bold
    ws.column_dimensions["A"].width = 46
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 22

    fills = {HIGH: "F8D7DA", MEDIUM: "FFF3CD", REVIEW: "E2E3E5", LOW: "D1E7DD"}

    def sheet(title, rows):
        s = wb.create_sheet(title)
        s.append(RESULT_COLS)
        for c in s[1]:
            c.font = bold
        for r in rows:
            s.append([r.get(c, "") for c in RESULT_COLS])
            f = fills.get(r["risk"])
            if f:
                s.cell(s.max_row, 2).fill = PatternFill("solid", fgColor=f)
        for i, w in enumerate([15, 9, 38, 44, 7, 7, 7, 18, 7, 20, 30, 30, 40], 1):
            s.column_dimensions[get_column_letter(i)].width = w
        s.freeze_panes = "A2"
        s.auto_filter.ref = s.dimensions

    sheet("VoIP numbers", [r for r in results if r["risk"] in (HIGH, MEDIUM)])
    sheet("All numbers", results)

    unk = collections.Counter()
    unk_nums = collections.Counter()
    for r in results:
        if r["risk"] == REVIEW:
            unk[(r["carrier"] or r["class"], r["ocn"], r["carrier_type"])] += r["calls"]
            unk_nums[(r["carrier"] or r["class"], r["ocn"], r["carrier_type"])] += 1
    s = wb.create_sheet("Carriers to review")
    s.append(["carrier", "ocn", "type", "numbers", "calls"])
    for c in s[1]:
        c.font = bold
    for k, calls in unk.most_common():
        s.append([k[0], k[1], k[2], unk_nums[k], calls])
    s.column_dimensions["A"].width = 50

    if intl:
        s = wb.create_sheet("International")
        s.append(["number", "calls"])
        for n, c in intl.most_common():
            s.append([n, c])

    xlsx = out_dir / "results.xlsx"
    wb.save(xlsx)

    with open(out_dir / "numbers.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=RESULT_COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    annotated = []
    for cdr in cdrs:
        dest = out_dir / f"{cdr.path.stem}_annotated.csv"
        with open(dest, "w", newline="") as f:
            w = csv.writer(f)
            extra = []
            for i in cdr.phone_cols:
                extra += [f"{cdr.header[i]}_e164", f"{cdr.header[i]}_risk", f"{cdr.header[i]}_carrier"]
            w.writerow(cdr.header + extra + ["max_risk"])
            for row in cdr.rows():
                row = list(row) + [""] * (cdr.width - len(row))
                add, best = [], None
                for i in cdr.phone_cols:
                    kind, num = normalize(row[i])
                    r = row_risk_lookup.get(num) if kind == "us" else None
                    risk = r["risk"] if r else ("INTL" if kind == "intl" else "")
                    add += [num or "", risk, r["carrier"] if r else ""]
                    if risk in RISK_ORDER and (best is None or RISK_ORDER[risk] < RISK_ORDER[best]):
                        best = risk
                w.writerow(row[:cdr.width] + add + [best or ""])
        annotated.append(dest)
    return xlsx, annotated


# --------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help="CDR files (csv, tsv, txt, xlsx)")
    ap.add_argument("-o", "--out", default="output", help="output directory")
    ap.add_argument("--cache", default=str(Path(__file__).resolve().parent / "cache"))
    ap.add_argument("--cols", help="comma-separated phone columns (names or 1-based indexes)")
    ap.add_argument("--lrn", action="append", help="LRN_COL:NUMBER_COL pairing (repeatable)")
    ap.add_argument("--offline", action="store_true", help="use cached block data only")
    ap.add_argument("--twilio", action="store_true", help="paid, port-aware Twilio line-type lookup")
    ap.add_argument("--twilio-limit", type=int, help="max new Twilio lookups this run")
    ap.add_argument("--twilio-only", choices=["voip", "review", "all"], default="all",
                    help="which numbers to send to Twilio (default all)")
    ap.add_argument("--no-annotate", action="store_true", help="skip annotated CDR copies")
    ap.add_argument("--dry-run", action="store_true", help="only show detected columns and counts")
    a = ap.parse_args(argv)

    forced = [c.strip() for c in a.cols.split(",")] if a.cols else None
    cdrs = [CDR(f, forced_cols=forced, forced_lrn=a.lrn) for f in a.files]

    stats = {}
    intl = collections.Counter()
    total_rows = invalid = 0
    for cdr in cdrs:
        print(f"{cdr.path.name}: header={'yes' if cdr.has_header else 'no'}; phone columns: "
              + (", ".join(f"{cdr.header[i]} ({cdr.col_scores.get(cdr.header[i], 0):.0%} valid)"
                           for i in cdr.phone_cols) or "NONE FOUND"))
        if cdr.lrn_pairs:
            print("  LRN: " + ", ".join(f"{cdr.header[l]} -> {cdr.header[n]}" for n, l in cdr.lrn_pairs.items()))
        if not cdr.phone_cols:
            print(f"  columns: {cdr.header}\n  candidate scores: {cdr.col_scores}\n  -> use --cols", file=sys.stderr)
            continue
        for row in cdr.rows():
            total_rows += 1
            for i in cdr.phone_cols:
                v = row[i] if i < len(row) else ""
                kind, num = normalize(v)
                if kind == "us":
                    st = stats.setdefault(num, {"calls": 0, "cols": set(), "lrns": collections.Counter()})
                    st["calls"] += 1
                    st["cols"].add(cdr.header[i])
                    li = cdr.lrn_pairs.get(i)
                    if li is not None and li < len(row):
                        lk, lnum = normalize(row[li])
                        if lk == "us":
                            st["lrns"][lnum] += 1
                elif kind == "intl":
                    intl[num] += 1
                elif str(v).strip() and str(v).strip().lower() not in PLACEHOLDERS:
                    invalid += 1
    for st in stats.values():
        st["lrn"] = st["lrns"].most_common(1)[0][0] if st["lrns"] else None

    npas = sorted({n[2:5] for n in stats} - TOLL_FREE - NON_GEOGRAPHIC)
    print(f"rows: {total_rows:,}  unique US numbers: {len(stats):,}  area codes: {len(npas)}  "
          f"international: {len(intl):,}  unparseable values: {invalid:,}")
    if a.dry_run or not stats:
        return 0

    db = PrefixDB(a.cache, offline=a.offline)
    for i, npa in enumerate(npas, 1):
        db.load(npa)
        if i % 25 == 0 or i == len(npas):
            print(f"  block data: {i}/{len(npas)} area codes")
    results = classify_numbers(stats, db)

    tw_res = None
    if a.twilio:
        pick = {"all": lambda r: r["risk"] != NA,
                "voip": lambda r: r["risk"] in (HIGH, MEDIUM),
                "review": lambda r: r["risk"] in (HIGH, MEDIUM, REVIEW)}[a.twilio_only]
        targets = [r["number"] for r in results if pick(r)]
        tw_res = Twilio(a.cache).lookup_many(targets, limit=a.twilio_limit)
        results = classify_numbers(stats, db, tw_res)

    by_risk = collections.Counter(r["risk"] for r in results)
    calls_by_risk = collections.Counter()
    for r in results:
        calls_by_risk[r["risk"]] += r["calls"]
    by_class = collections.Counter((r["risk"], r["class"]) for r in results)
    voip_carriers = collections.Counter()
    for r in results:
        if r["risk"] == HIGH:
            voip_carriers[r["carrier"] or r["class"]] += 1
    n = len(results) or 1
    mode = "Twilio line type (port-aware)" if a.twilio else (
        "Block holder + LRN (port-aware where LRN present)" if any(c.lrn_pairs for c in cdrs)
        else "Block holder (original carrier of the number block; not port-aware)")
    summary = [
        ["CDR VOIP CHECK"],
        ["Run", dt.datetime.now().strftime("%Y-%m-%d %H:%M")],
        ["Files", ", ".join(c.path.name for c in cdrs)],
        ["Method", mode],
        ["CDR rows", total_rows],
        ["Unique US numbers", len(results)],
        ["International numbers", len(intl)],
        [],
        ["RISK", "numbers", "% of numbers", "call legs"],
    ]
    labels = {HIGH: "HIGH - non-fixed VoIP", MEDIUM: "MEDIUM - other VoIP", REVIEW: "REVIEW - unrecognized",
              LOW: "LOW - mobile / landline / cable", NA: "N/A - toll-free / special"}
    for k in (HIGH, MEDIUM, REVIEW, LOW, NA):
        summary.append([labels[k], by_risk.get(k, 0), f"{by_risk.get(k, 0) / n:.1%}", calls_by_risk.get(k, 0)])
    summary += [[], ["BREAKDOWN", "numbers"]]
    for (risk, cls), c in sorted(by_class.items(), key=lambda kv: (RISK_ORDER.get(kv[0][0], 9), -kv[1])):
        summary.append([f"{risk} - {cls}", c])
    summary += [[], ["TOP HIGH-RISK CARRIERS", "numbers"]]
    for name, c in voip_carriers.most_common(15):
        summary.append([name, c])
    summary += [[], ["COLUMNS USED"]]
    for c in cdrs:
        summary.append([c.path.name, ", ".join(c.header[i] for i in c.phone_cols)])
    if not a.twilio:
        summary += [[], ["NOTE"], ["Block-holder mode shows the carrier the number block was assigned to. "
                                   "Numbers ported since then (e.g. a Verizon number moved to Google Voice) "
                                   "can be misclassified. Run with --twilio for port-aware results."]]

    lookup = {r["number"]: r for r in results}
    xlsx, ann = write_outputs(Path(a.out), results, intl, summary, [] if a.no_annotate else cdrs, lookup)
    print("\nRISK          numbers")
    for k in (HIGH, MEDIUM, REVIEW, LOW, NA):
        print(f"  {k:<8} {by_risk.get(k, 0):>10,}  ({by_risk.get(k, 0) / n:.1%})")
    print(f"\nwrote {xlsx}")
    for p in ann:
        print(f"wrote {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
