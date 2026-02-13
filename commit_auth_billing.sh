#!/bin/bash
cd /home/jkang1643/projects/realtimetranslationapp

# Stage all changes
git add .

# Commit with the message from file
git commit -F COMMIT_MESSAGE_AUTH_BILLING.txt

# Push to the feature branch
git push origin feat/auth-db-billing

echo "✅ Successfully committed and pushed to feat/auth-db-billing"
