' 看门狗：每 30 秒检查 bot.js 是否存活，死亡则自动拉起（供开机自启调用，无窗口）
' 用法：wscript watchdog.vbs（与 bot.js 同目录即可，路径自动相对本 vbs）
Option Explicit
Dim ws, fso, wmi, dir, pidFile, pidText, pid, procs, alive, botJs
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = dir
pidFile = fso.BuildPath(dir, "bot.pid")
botJs = fso.BuildPath(dir, "bot.js")
Do
  alive = False
  If fso.FileExists(pidFile) Then
    On Error Resume Next
    pidText = ""
    Dim tf: Set tf = fso.OpenTextFile(pidFile, 1)
    pidText = Trim(tf.ReadAll)
    tf.Close
    If IsNumeric(pidText) Then
      pid = CLng(pidText)
      Set wmi = GetObject("winmgmts:\\.\root\cimv2")
      Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
      If procs.Count > 0 Then alive = True
    End If
    On Error GoTo 0
  End If
  If Not alive Then
    ' 同步运行：bot 退出后回到本循环，30 秒后再检查（单实例锁保证不重复拉起）
    ws.Run "node """ & botJs & """", 0, True
  End If
  WScript.Sleep 30000
Loop
