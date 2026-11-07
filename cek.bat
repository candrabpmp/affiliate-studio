@echo off
rem Periksa isi database tanpa membuka aplikasi.
cd /d "%~dp0"
python cek.py --items
echo.
pause
