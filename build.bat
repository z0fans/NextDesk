@echo off
REM NextDesk Build Script for Windows
REM Run this script in the project root directory

echo === NextDesk Build Script ===
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.10+
    exit /b 1
)

REM Create virtual environment if not exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Install dependencies
echo Installing Python dependencies...
pip install -r requirements.txt
pip install pyinstaller

REM Build frontend (if Node.js available)
where npm >nul 2>&1
if not errorlevel 1 (
    echo Building frontend...
    cd frontend
    call npm install
    call npm run build
    cd ..
) else (
    echo WARNING: npm not found, skipping frontend build
    echo Make sure backend\web contains the built frontend files
)

REM Run PyInstaller
echo Building executable...
pyinstaller build.spec --clean --noconfirm

if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    exit /b 1
)

echo.
echo === Build Complete ===
echo Output: dist\NextDesk\NextDesk.exe
echo.
echo To create installer, run Inno Setup with setup.iss
pause
