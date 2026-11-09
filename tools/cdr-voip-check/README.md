# CDR VoIP check

Flags **non-fixed VoIP** numbers (Google Voice, TextNow, burner/app numbers, CPaaS numbers) in US call detail records (CDRs).

## Run

```bash
python3 cdr_voip_check.py /path/to/cdr.csv -o output/
```

- Input: CSV / TSV / pipe / TXT / XLSX, with or without a header row. Phone columns are found automatically (override with `--cols ANI,DNIS`). Check what it found first with `--dry-run`.
- Output (in `-o`):
  - `results.xlsx`: Summary, VoIP numbers (HIGH + MEDIUM), All numbers, Carriers to review, International
  - `numbers.csv`: one row per unique number
  - `<file>_annotated.csv`: the original CDR plus risk and carrier for each phone column
- Needs Python 3.9+ with `openpyxl` (and `pandas` for Excel input).

## Risk levels

| Risk | Meaning |
|---|---|
| HIGH | Non-fixed VoIP: CPaaS or wholesale app numbers (Bandwidth, Onvoy/Inteliquent, Twilio, Telnyx, Peerless, Commio, ...) |
| MEDIUM | Other VoIP: business, nomadic or mixed (Level 3/Lumen, Vonage, RingCentral, ...) |
| REVIEW | Carrier not recognized yet. Check it and add a rule to `carriers.py` |
| LOW | Mobile, landline, cable phone (Comcast, Spectrum, Cox, ...) |
| N/A | Toll-free / special numbers |

## How it decides

1. **Free (default):** looks up each number's block (NPA-NXX-X) in public NANP assignment data from localcallingguide.com, cached per area code in `cache/`. This gives the carrier the block was **originally** assigned to, then `carriers.py` maps it to a risk level. If the CDR has an **LRN** column, it uses the LRN instead, which shows the carrier after porting.
2. **Paid, port-aware (`--twilio`):** runs Twilio Lookup v2 Line Type Intelligence (`nonFixedVoip` / `fixedVoip` / `mobile` / `landline`) and overrides the block result. Results are cached in `cache/twilio.jsonl`, so you never pay twice for the same number. Set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, or let the session proxy inject saved credentials.
   - `--twilio-only voip`: only re-check numbers flagged HIGH or MEDIUM (cheapest)
   - `--twilio-only review`: also re-check REVIEW numbers
   - `--twilio-limit N`: cap the number of new lookups per run

**Limit of free mode:** numbers ported since their block was assigned (for example, a Verizon number moved to Google Voice) can be misclassified. Use `--twilio` (or an LRN column) for results you hand to a client.

## Tests

```bash
python3 -m unittest discover -s tests
```
