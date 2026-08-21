@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  TallyPrime for Claude - Setup
rem
rem  Double-click this once after unzipping. Safe to run again at any time; run
rem  it again after moving this folder, or after unzipping a new version.
rem
rem  All this file does is find a Node runtime and hand over to scripts\setup.mjs,
rem  which holds the real logic. The bundled runtime under node\ is preferred so
rem  the install does not depend on the user having Node installed.
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "NODE_EXE=%HERE%node\node.exe"

if not exist "%NODE_EXE%" (
  rem Development fallback: no bundled runtime in the source checkout.
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Setup could not start.
    echo.
    echo   This copy is missing its program files, so there is nothing to set up.
    echo.
    echo   What to do:  delete this folder, download the zip again, then
    echo   right-click it and choose "Extract All" before running Setup.
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
if not exist "%SCRIPTS%\setup.mjs" set "SCRIPTS=%HERE%scripts"

"%NODE_EXE%" "%SCRIPTS%\setup.mjs"
set "RESULT=%ERRORLEVEL%"

rem setup.mjs pauses on its own when it has a console; this is the safety net for
rem the case where it crashed before reaching that point.
if not "%RESULT%"=="0" pause

endlocal & exit /b %RESULT%
