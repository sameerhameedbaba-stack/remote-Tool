"""Carrier -> risk rules.

Each phone-number block in the US is assigned to one carrier (by its OCN).
These rules turn that carrier's name into a class and a risk level.
Edit this file to tune results: first matching rule wins.

Risk levels
  HIGH    non-fixed VoIP: CPaaS / wholesale numbers behind Google Voice,
          TextNow, burner and other app numbers.
  MEDIUM  other VoIP: business / nomadic VoIP (Vonage, RingCentral, ...)
          and mixed carriers that also wholesale numbers to VoIP apps.
  LOW     mobile, traditional landline, cable phone (Comcast, Spectrum, ...).
  REVIEW  carrier not recognized yet - check it and add a rule here.
"""

import re

HIGH, MEDIUM, LOW, REVIEW, NA = "HIGH", "MEDIUM", "LOW", "REVIEW", "N/A"

# (regex on upper-cased company name, class, risk); checked first.
VOIP_RULES = [
    # --- Non-fixed VoIP / CPaaS / wholesale app numbers -> HIGH
    (r"\bONVOY\b|INTELIQUENT|NEUTRAL TANDEM|\bSINCH\b", "Non-fixed VoIP (wholesale / CPaaS)", HIGH),
    (r"\bBANDWIDTH\b", "Non-fixed VoIP (wholesale / CPaaS)", HIGH),
    (r"\bTWILIO\b", "Non-fixed VoIP (CPaaS)", HIGH),
    (r"\bTELNYX\b", "Non-fixed VoIP (CPaaS)", HIGH),
    (r"\bCOMMIO\b|\bTHINQ\b", "Non-fixed VoIP (CPaaS)", HIGH),
    (r"\bPLIVO\b|\bSIGNALWIRE\b|\bVOXBONE\b|\bFLOWROUTE\b", "Non-fixed VoIP (CPaaS)", HIGH),
    (r"PEERLESS NETWORK", "Non-fixed VoIP (wholesale / CPaaS)", HIGH),
    (r"VOIP INNOVATIONS|\bSKYETEL\b", "Non-fixed VoIP (wholesale / CPaaS)", HIGH),
    (r"\bGOOGLE\b", "Non-fixed VoIP (Google Voice)", HIGH),
    (r"\bYMAX\b|MAGICJACK", "Non-fixed VoIP (magicJack)", HIGH),
    (r"\bTEXTNOW\b|\bENFLICK\b|\bPINGER\b", "Non-fixed VoIP (app numbers)", HIGH),
    # VoIP number wholesalers (most hold numbers as interconnected-VoIP providers)
    (r"HD CARRIER|\bTON80\b|TERRA NOVA TELECOM|\bNUSO\b|IP HORIZON|WIDE VOICE|RINGSQUARED|"
     r"\bBRIGHTLINK\b|\bCALLWORKS\b", "Non-fixed VoIP (number wholesaler)", HIGH),
    (r"\bFIVE9\b", "Non-fixed VoIP (contact-center platform)", HIGH),

    # --- Other VoIP -> MEDIUM
    (r"LEVEL 3|\bLUMEN\b", "Mixed carrier (also wholesales VoIP numbers)", MEDIUM),
    (r"\bVONAGE\b|\bNEXMO\b", "VoIP (nomadic / business / API)", MEDIUM),
    (r"RINGCENTRAL|\b8X8\b|\bZOOM\b|\bDIALPAD\b|\bNEXTIVA\b|\bOOMA\b|\bMICROSOFT\b|\bSKYPE\b",
     "VoIP (business / UCaaS)", MEDIUM),
    (r"\bFRACTEL\b|LEAP TELECOM|\bEXIANT\b|\bWAVENATION\b|\bIDT\b|\bINTRADO\b|FUSION CLOUD|"
     r"\bAIRESPRING\b|DIGITALIPVOICE", "VoIP (business / wholesale mix)", MEDIUM),
    (r"\bVOIP\b", "VoIP provider", MEDIUM),
]

# Checked only after VOIP_RULES and the mobile (W) / ILEC (I) type checks.
OTHER_RULES = [
    # --- Mobile carriers that sometimes hold blocks under a non-W type
    (r"\bBOOST\b|\bDISH WIRELESS\b|CELLCO|VERIZON WIRELESS|T-MOBILE|CINGULAR|\bSPRINT\b|"
     r"\bMETROPCS\b|US CELLULAR|UNITED STATES CELLULAR", "Mobile", LOW),

    # --- Cable phone (fixed VoIP tied to an address) -> LOW
    (r"\bCOMCAST\b|\bCHARTER\b|\bSPECTRUM\b|TIME WARNER CABLE|BRIGHT HOUSE|\bCOX\b|\bALTICE\b|"
     r"CABLEVISION|\bCEQUEL\b|SUDDENLINK|\bOPTIMUM\b|\bMEDIACOM\b|\bASTOUND\b|\bRCN\b|"
     r"WIDEOPENWEST|\bKNOLOGY\b|CABLE ONE|SPARKLIGHT|\bARMSTRONG\b|BREEZELINE|ATLANTIC BROADBAND|"
     r"TWC IP ENABLED|CSC VOICE|\bGRANDE\b",
     "Cable phone (fixed, address-bound)", LOW),

    # --- Traditional / business landline CLECs -> LOW
    (r"TELEPORT COMMUNICATIONS|TC SYSTEMS|\bBELL\b|BELLSOUTH|FIRST COMMUNICATIONS|\bAT&T\b|\bMCIMETRO\b|\bVERIZON\b|\bXO\b|\bPAETEC\b|"
     r"TELEPACIFIC|\bTPX\b|\bWINDSTREAM\b|\bFRONTIER\b|\bCONSOLIDATED\b|\bCENTURYLINK\b|"
     r"\bQWEST\b|\bALLSTREAM\b|\bSONIC\b|\bGRANITE\b|\bCOGENT\b|\bZAYO\b",
     "Landline (business / traditional CLEC)", LOW),

    # --- Paging -> LOW
    (r"\bSPOK\b|AMERICAN MESSAGING", "Paging", LOW),
]

# LERG company type letter -> (class, risk) when no name rule matches
TYPE_RULES = {
    "W": ("Mobile", LOW),
    "I": ("Landline (ILEC)", LOW),
    "C": ("Other CLEC (unrecognized)", REVIEW),
}

_VOIP = [(re.compile(p), cls, risk) for p, cls, risk in VOIP_RULES]
_OTHER = [(re.compile(p), cls, risk) for p, cls, risk in OTHER_RULES]


def classify_carrier(company_name, company_type):
    """Return (class, risk) for a block holder."""
    name = (company_name or "").upper()
    ctype = (company_type or "").upper()
    for rx, cls, risk in _VOIP:
        if rx.search(name):
            return cls, risk
    if ctype in ("W", "I"):
        return TYPE_RULES[ctype]
    for rx, cls, risk in _OTHER:
        if rx.search(name):
            return cls, risk
    return TYPE_RULES.get(ctype, ("Unknown carrier", REVIEW))


# Twilio Lookup v2 line_type_intelligence.type -> (class, risk)
TWILIO_TYPES = {
    "nonFixedVoip": ("Non-fixed VoIP", HIGH),
    "fixedVoip": ("Fixed VoIP (address-bound, e.g. cable)", LOW),
    "mobile": ("Mobile", LOW),
    "landline": ("Landline", LOW),
    "tollFree": ("Toll-free", NA),
    "premium": ("Premium rate", NA),
    "sharedCost": ("Shared cost", NA),
    "personal": ("Personal number", REVIEW),
    "pager": ("Paging", LOW),
    "voicemail": ("Voicemail", REVIEW),
    "uan": ("Universal access number", NA),
}
