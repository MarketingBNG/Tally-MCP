' ---------------------------------------------------------------------------
'  TallyPrime for Claude - silent export launcher
'
'  This is what the SCHEDULED TASK runs. It does one thing: start
'  Run-Export.bat with no console window, so nothing flashes on screen every
'  minute while somebody is trying to work.
'
'  Double-click Run-Export.bat yourself when you want to WATCH it run. This
'  file is for the scheduler, and shows nothing.
'
'  WHY NOT JUST RUN THE TASK "WHETHER OR NOT THE USER IS LOGGED ON"?
'
'  That is the other obvious fix, and it does produce no window at all -- the
'  task runs in a session with no desktop, so there is nothing to draw. It was
'  rejected because that same missing desktop is where the failure notification
'  has to appear. A run in session 0 cannot raise a Windows toast, so the first
'  time TallyPrime was closed at 6pm nobody would be told; the export would go
'  quiet and the spreadsheet would age without a word. The filename in the
'  folder and Check-Tally would still say so, but only to somebody who thought
'  to look.
'
'  So: interactive session, keep the toast, and hide the window here instead.
'
'  Two details that matter, and are easy to get wrong:
'
'  1. Window style 0 = hidden. That is the whole point of this file. Running
'     the .bat directly from Task Scheduler flashes a cmd.exe window once a
'     minute, which is intolerable on a machine somebody is using.
'
'  2. bWaitOnReturn = True. It would be tempting to fire and forget, but then
'     this launcher exits immediately, the scheduled task is recorded as
'     finished while the export is still going, and TWO things break: the
'     task's "do not start a new instance" overlap guard stops working, and
'     the task's Last Result no longer reflects whether the export succeeded.
'     So it waits, and passes the real exit code back.
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, here, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Beside this file, whatever it was renamed or moved to.
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Quoted: the install folder is very often under a path with spaces in it.
command = """" & here & "\Run-Export.bat"" --quiet"

' 0 = hidden window. True = wait for it to finish. See the notes above.
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
