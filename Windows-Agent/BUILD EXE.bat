@echo off
setlocal
cd /d "%~dp0"
title Phone Remote - Build EXE

echo.
echo ==========================================
echo        PHONE REMOTE - WINDOWS BUILD
echo ==========================================
echo.
echo This will create: dist\Phone Remote.exe
echo.

where py >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python was not found.
    echo Install Python for Windows first, then run this file again.
    echo.
    pause
    exit /b 1
)

echo [1/4] Checking pip...
py -m pip --version >nul 2>nul
if errorlevel 1 (
    echo pip is missing. Installing pip with Python ensurepip...
    py -m ensurepip --upgrade
    if errorlevel 1 goto :pip_failed
)

py -m pip --version >nul 2>nul
if errorlevel 1 goto :pip_failed

py -m pip install --upgrade pip
if errorlevel 1 goto :failed

echo.
echo [2/4] Installing app dependencies...
py -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo.
echo [3/4] Installing EXE builder...
py -m pip install "pyinstaller>=6.10"
if errorlevel 1 goto :failed

echo.
echo [4/4] Building Phone Remote.exe...
py -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --name "Phone Remote" ^
  --icon "app.ico" ^
  --add-data "app.ico;." ^
  --collect-all pycaw ^
  --collect-all comtypes ^
  agent.py
if errorlevel 1 goto :failed

echo.
echo ==========================================
echo BUILD COMPLETE
echo ==========================================
echo.
echo Your finished program is here:
echo   %CD%\dist\Phone Remote.exe
echo.
echo You can copy that EXE to another Windows PC.
echo That PC does NOT need PyCharm or Python installed.
echo.
explorer "%CD%\dist"
pause
exit /b 0

:pip_failed
echo.
echo BUILD FAILED: pip could not be installed for this Python.
echo.
echo Try repairing Python from Windows Apps / Installed Apps and make sure
 echo the optional pip component is enabled, then run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo BUILD FAILED.
echo Read the error above, then run BUILD EXE.bat again.
echo.
pause
exit /b 1
