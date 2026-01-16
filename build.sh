#!/bin/bash
# NextDesk Build Script for macOS/Linux (development only)
# Note: Windows EXE must be built on Windows

set -e

echo "=== NextDesk Development Build ==="
echo

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python3 not found"
    exit 1
fi

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies
echo "Installing Python dependencies..."
pip install -r requirements.txt

# Build frontend
if command -v npm &> /dev/null; then
    echo "Building frontend..."
    cd frontend
    npm install
    npm run build
    cd ..
else
    echo "WARNING: npm not found, skipping frontend build"
fi

echo
echo "=== Development Setup Complete ==="
echo
echo "To run in development mode:"
echo "  cd frontend && npm run dev"
echo "  cd backend && NEXTDESK_DEV=1 python main.py"
echo
echo "To build Windows EXE, run build.bat on Windows"
