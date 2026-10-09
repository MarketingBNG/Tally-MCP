@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  TallyPrime for Claude - Uninstall
rem
rem  Double-click to remove the automatic export and the Tally connection from
rem  Claude Desktop, Codex and UIC GPT. Leaves TallyPrime, your other Claude
rem  connections and the spreadsheets in your export folder untouched. Delete
rem  this folder afterwards.
rem
rem  Like Setup.bat, this only finds a Node runtime and hands over to
rem  scripts\uninstall.mjs, which holds the real logic.
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "NODE_EXE=%HERE%node\node.exe"

if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Uninstall could not start: this copy is missing its program files.
    echo.
    echo   What to do:  run Uninstall from the folder you ran Setup from.
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

set "SCRIPTS=%HERE%app\scripts"
if not exist "%SCRIPTS%\uninstall.mjs" set "SCRIPTS=%HERE%scripts"

"%NODE_EXE%" "%SCRIPTS%\uninstall.mjs"
set "RESULT=%ERRORLEVEL%"

endlocal & exit /b %RESULT%
