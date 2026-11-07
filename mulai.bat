@echo off
rem Jalankan Affiliate Studio dengan database SQLite lokal.
rem Data tersimpan di data\affiliate.db, bukan di browser.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python tidak ditemukan di PATH.
  echo Install Python dulu, lalu jalankan file ini lagi.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem Port 8787 sudah dipakai? JANGAN jalankan server kedua.
rem Di Windows, dua proses boleh bind ke port yang sama (SO_REUSEADDR), dan
rem browser dilayani salah satunya secara acak. Akibatnya muncul dua gejala
rem yang menyesatkan: "server tidak menjawab", atau halaman jalan tapi route
rem baru balas 404 karena yang menjawab proses LAMA. Lebih baik berhenti di
rem sini dan bilang terus terang.
rem ---------------------------------------------------------------------------
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 goto start

set "VCODE="
for /f %%c in ('curl -s -m 3 -o nul -w "%%{http_code}" http://127.0.0.1:8787/api/videos 2^>nul') do set "VCODE=%%c"

if "%VCODE%"=="200" (
  echo.
  echo Server sudah jalan dengan kode terbaru. Membuka browser.
  echo Kalau tampilan masih versi lama, tekan Ctrl+Shift+R di browser.
  start "" http://127.0.0.1:8787/
  timeout /t 3 >nul
  exit /b 0
)

echo.
echo Port 8787 sudah dipakai, tapi bukan server versi terbaru.
echo Cek /api/videos menjawab: %VCODE%  (yang diharapkan 200)
echo.
echo Tutup dulu jendela cmd server yang lama, lalu jalankan file ini lagi.
echo Kalau tidak tahu jendela mana, cari PID-nya:
echo     netstat -ano ^| findstr :8787
echo lalu matikan:
echo     taskkill /PID angka /F
echo.
pause
exit /b 1

:start
echo Menjalankan server di http://127.0.0.1:8787/
start "" /min cmd /c "python server.py"
timeout /t 2 >nul
start "" http://127.0.0.1:8787/

echo.
echo Server jalan di jendela terpisah (minimize). Tutup jendela itu untuk mematikan.
echo Tekan tombol apa saja untuk menutup jendela ini.
pause >nul
