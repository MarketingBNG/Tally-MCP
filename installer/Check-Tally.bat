@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  TallyPrime for Claude - Check
rem
rem  Double-click this whenever Claude says it cannot see your Tally data. It
rem  reads your settings and asks TallyPrime for its company list; it changes
rem  nothing, in Tally or anywhere else.
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "NODE_EXE=%HERE%node\node.exe"

if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   The check could not start.
    echo.
    echo   This copy is missing its program files.
    echo.
    echo   What to do:  delete this folder, download the zip again, then
    echo   right-click it and choose "Extract All".
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
if not exist "%SCRIPTS%\doctor.mjs" set "SCRIPTS=%HERE%scripts"

"%NODE_EXE%" "%SCRIPTS%\doctor.mjs"
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" pause

endlocal & exit /b %RESULT%
