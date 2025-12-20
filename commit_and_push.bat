@echo off
echo Switching to core-engine branch...
wsl bash -c "cd /home/jkang1643/projects/realtimetranslationapp && git checkout core-engine 2>nul || git checkout -b core-engine"

echo.
echo Staging all changes...
wsl bash -c "cd /home/jkang1643/projects/realtimetranslationapp && git add -A"

echo.
echo Committing with detailed message...
wsl bash -c "cd /home/jkang1643/projects/realtimetranslationapp && git commit -F COMMIT_MESSAGE_BIBLE_RECOGNITION.txt"

echo.
echo Pushing to core-engine branch...
wsl bash -c "cd /home/jkang1643/projects/realtimetranslationapp && git push -u origin core-engine"

echo.
echo Done!
