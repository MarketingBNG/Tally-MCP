# Collect ground-truth TallyPrime responses for tally-mcp.
#
# RUN THIS ON THE MACHINE WHERE TALLYPRIME IS RUNNING (Windows).
#
#   1. Open TallyPrime and load your company.
#   2. Enable the HTTP server:
#        F1 (Help) > Settings > Connectivity > Client/Server configuration
#        - TallyPrime acts as : Both   (or Server)
#        - Port               : 9000
#   3. Open PowerShell in this folder and run:
#        powershell -ExecutionPolicy Bypass -File .\fetch-samples.ps1
#   4. Copy the resulting `samples\` folder back to the Mac project.
#
# The script only EXPORTS. It sends no Import/Alter/Delete request and cannot
# modify your data. Every request below uses TALLYREQUEST=Export.

param(
    [string]$TallyHost = "127.0.0.1",
    [int]$Port = 9000,
    [string]$OutDir = "samples",
    # Narrow window keeps the voucher/day book samples small. Widen if empty.
    [string]$FromDate = "",
    [string]$ToDate = ""
)

$ErrorActionPreference = "Stop"
$base = "http://${TallyHost}:${Port}"

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# Default to the last 30 days if no range was given.
if ([string]::IsNullOrEmpty($FromDate)) { $FromDate = (Get-Date).AddDays(-30).ToString("yyyyMMdd") }
if ([string]::IsNullOrEmpty($ToDate))   { $ToDate   = (Get-Date).ToString("yyyyMMdd") }

Write-Host "Tally endpoint : $base"
Write-Host "Date range     : $FromDate to $ToDate"
Write-Host "Output folder  : $OutDir"
Write-Host ""

function Invoke-Tally {
    param([string]$Name, [string]$Body, [string]$FileName)

    Write-Host -NoNewline "  $Name ... "
    try {
        $response = Invoke-WebRequest -Uri $base -Method Post -Body $Body `
            -ContentType "text/xml;charset=utf-8" -TimeoutSec 120 -UseBasicParsing

        $path = Join-Path $OutDir $FileName
        # Write bytes rather than text so the ORIGINAL encoding and any control
        # characters survive. Those quirks are exactly what we need to see.
        [System.IO.File]::WriteAllBytes($path, $response.RawContentStream.ToArray())

        $size = (Get-Item $path).Length
        Write-Host "ok ($size bytes)" -ForegroundColor Green
    }
    catch {
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $errPath = Join-Path $OutDir "$FileName.error.txt"
        $_.Exception.Message | Out-File -FilePath $errPath -Encoding utf8
    }
}

# --- 1. Company list -------------------------------------------------------
Invoke-Tally "Company list" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No">
    <TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>StartingFrom</NATIVEMETHOD>
  </COLLECTION></TDLMESSAGE></TDL></DESC></BODY>
</ENVELOPE>
"@ "company-list.xml"

# --- 2. Ledger list --------------------------------------------------------
Invoke-Tally "Ledger list" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Ledgers</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE><COLLECTION NAME="Ledgers" ISMODIFY="No">
    <TYPE>Ledger</TYPE>
    <NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD>
    <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD><NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
    <NATIVEMETHOD>LedgerPhone</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
  </COLLECTION></TDLMESSAGE></TDL></DESC></BODY>
</ENVELOPE>
"@ "ledger-list.xml"

# --- 3. Day book (vouchers in range) ---------------------------------------
Invoke-Tally "Day book" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>DayBook</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "day-book.xml"

# --- 4. Vouchers (full detail) ---------------------------------------------
Invoke-Tally "Vouchers (detailed)" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Voucher Register</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
    <EXPLODEFLAG>Yes</EXPLODEFLAG>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "voucher.xml"

# --- 5. Trial balance ------------------------------------------------------
Invoke-Tally "Trial balance" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "trial-balance.xml"

# --- 6. Balance sheet / P&L ------------------------------------------------
Invoke-Tally "Balance sheet" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Balance Sheet</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "balance-sheet.xml"

Invoke-Tally "Profit and loss" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Profit and Loss</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "profit-loss.xml"

# --- 7. JSON variant (TallyPrime 7.0+ native JSON) -------------------------
# If this returns JSON, the server can prefer the JSON path. If it errors or
# returns XML anyway, that is itself a useful finding - keep the file.
Invoke-Tally "Trial balance (JSON attempt)" @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Trial Balance</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVEXPORTFORMAT>`$`$SysName:JSON</SVEXPORTFORMAT>
    <SVEXPORTINPLAINFORMAT>Yes</SVEXPORTINPLAINFORMAT>
    <SVFROMDATE>$FromDate</SVFROMDATE><SVTODATE>$ToDate</SVTODATE>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>
"@ "trial-balance.json"

# --- 8. Deliberate error ---------------------------------------------------
#
# REMOVED 2026-08-10. Do not reinstate these.
#
# This script previously ended with two intentionally-malformed requests, to
# capture Tally's error response shape. Run against a real TallyPrime 7.x
# install, they did not return an error. The first — a Collection request
# naming "Ledgers" without defining it in a <TDL> block — caused TallyPrime to
# raise a modal dialog on the desktop:
#
#     Error in TDL. 'Collection:Ledgers' Could not find description!
#
# TallyPrime then stopped serving HTTP entirely, and EXITED when the dialog was
# dismissed. The request never returned, and every later request in the run
# failed against a dead server.
#
# So: a malformed TDL reference does not produce a parseable error, it takes
# down the user's accounting application. Capturing an error sample is not
# worth that, and there is no safe variant of this request known yet.
#
# See docs/known-limitations.md, "A malformed request can terminate
# TallyPrime".

Write-Host ""
Write-Host "Done. Files written to '$OutDir':" -ForegroundColor Cyan
Get-ChildItem $OutDir | Format-Table Name, Length -AutoSize

Write-Host ""
Write-Host "BEFORE SENDING THESE BACK:" -ForegroundColor Yellow
Write-Host "  These contain real accounting data. Redact freely - replace names"
Write-Host "  and amounts with fake ones if you like. KEEP the tag names and"
Write-Host "  nesting intact; that structure is the entire point."
Write-Host ""
Write-Host "  Do NOT clean up odd characters in narrations. Those quirks are"
Write-Host "  what the parser most needs to be tested against."
