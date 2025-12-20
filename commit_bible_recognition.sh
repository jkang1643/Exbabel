#!/bin/bash
cd /home/jkang1643/projects/realtimetranslationapp

# Check current branch
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"

# Switch to core-engine branch (create if doesn't exist)
if ! git show-ref --verify --quiet refs/heads/core-engine; then
  echo "Creating core-engine branch..."
  git checkout -b core-engine
else
  echo "Switching to core-engine branch..."
  git checkout core-engine
fi

# Add all changes
echo "Staging all changes..."
git add -A

# Show what will be committed
echo "Files to be committed:"
git status --short

# Commit with detailed message
echo "Committing changes..."
git commit -F COMMIT_MESSAGE_BIBLE_RECOGNITION.txt

# Push to core-engine branch
echo "Pushing to core-engine branch..."
git push -u origin core-engine

echo "✅ Commit and push complete!"
