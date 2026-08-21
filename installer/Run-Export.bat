@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  TallyPrime for Claude - Export to a spreadsheet
rem
rem  This is what the scheduled task runs, every minute. Most of those minutes
rem  it asks TallyPrime one cheap question - "has anything changed?" - and stops
rem  there. It only writes a workbook when the answer is yes, or once a day
rem  regardless so the file's as-at date keeps moving.
rem
rem  You can also double-click it to export right now.
rem
rem  It never writes to TallyPrime. Every request it sends is an export request.
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"

rem Task Scheduler runs an action with the working directory set to
rem C:\Windows\System32, not to this folder. Settings live in the .env beside
rem the server, so run from here. export.mjs also loads that file by absolute
rem path, so this is belt-and-braces rather than the only guard.
cd /d "%HERE%"
set "NODE_EXE=%HERE%node\node.exe"

if not exist "%NODE_EXE%" (
  rem Development fallback: no bundled runtime in the source checkout.
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   The export could not start.
    echo.
    echo   This copy is missing its program files, so there is nothing to run.
    echo.
    echo   What to do:  delete this folder, download the zip again, then
    echo   right-click it and choose "Extract All" before running anything.
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

rem The payload lives under app\ on an install that can update itself: the
rem scripts move with each version while this .bat and node\ stay put. A source
rem checkout has scripts\ beside this file instead, so both are accepted.
set "SCRIPTS=%HERE%app\scripts"
if not exist "%SCRIPTS%\export.mjs" set "SCRIPTS=%HERE%scripts"

"%NODE_EXE%" "%SCRIPTS%\export.mjs" %*
set "RESULT=%ERRORLEVEL%"

rem Run by hand, from a double-click, this holds the window open on a failure so
rem the reason can be read. Run by the scheduler there is no console attached and
rem --quiet is passed, so this is skipped and the news is in the folder instead:
rem a "LAST RUN ..." file, a line in run-log.txt, and a toast on a change of state.
if not "%RESULT%"=="0" if "%~1"=="" pause

endlocal & exit /b %RESULT%
