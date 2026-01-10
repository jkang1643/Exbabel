#!/bin/bash

# Simple script to install Google Cloud SDK (gcloud) on Linux
# This is used for authentication and managing Google Cloud resources.

if command -v gcloud &> /dev/null; then
    echo "gcloud is already installed."
    gcloud --version
    exit 0
fi

echo "Installing Google Cloud SDK..."

# Download and run the install script
curl https://sdk.cloud.google.com | bash -s -- --disable-prompts

# Add to current shell session
if [ -f "$HOME/google-cloud-sdk/path.bash.inc" ]; then
    source "$HOME/google-cloud-sdk/path.bash.inc"
    echo "gcloud installed successfully."
    gcloud --version
    
    echo ""
    echo "IMPORTANT: Please add the following to your .bashrc or .zshrc:"
    echo "source \$HOME/google-cloud-sdk/path.bash.inc"
    echo "source \$HOME/google-cloud-sdk/completion.bash.inc"
else
    echo "Installation finished, but path.bash.inc not found in expected location."
fi
