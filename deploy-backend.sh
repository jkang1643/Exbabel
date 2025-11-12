#!/bin/bash

# Exbabel - Backend Update Script for EC2
# Run this script ON your EC2 instance to update the backend

set -e  # Exit on error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Exbabel Backend Update${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${RED}❌ PM2 not found. Installing...${NC}"
    sudo npm install -g pm2
fi

# Navigate to backend directory
cd /home/ubuntu/realtimetranslationapp/backend || {
    echo -e "${RED}❌ Backend directory not found at /home/ubuntu/realtimetranslationapp/backend${NC}"
    echo -e "${YELLOW}Modify this script if your installation path is different${NC}"
    exit 1
}

# Pull latest changes (if using git)
if [ -d ".git" ]; then
    echo -e "\n${YELLOW}📥 Pulling latest changes from git...${NC}"
    git pull origin main || git pull origin master || echo -e "${YELLOW}⚠️  Git pull skipped${NC}"
fi

# Install/update dependencies
echo -e "\n${YELLOW}📦 Installing dependencies...${NC}"
npm install

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "\n${RED}❌ .env file not found!${NC}"
    echo -e "${YELLOW}Creating template .env file...${NC}"
    
    cat > .env << 'EOF'
# OpenAI API Key (required for translation)
OPENAI_API_KEY=your-openai-api-key-here

# Google Cloud Speech API Key (required for transcription)
GOOGLE_SPEECH_API_KEY=your-google-api-key-here

# Or use Service Account JSON (more secure)
# GOOGLE_APPLICATION_CREDENTIALS=/home/ubuntu/realtimetranslationapp/backend/google-credentials.json

# Google Cloud PhraseSet Configuration (Optional - improves recognition accuracy)
# GOOGLE_CLOUD_PROJECT_ID=your-project-id
# GOOGLE_PHRASE_SET_ID=your-phrase-set-id

# Server Configuration
PORT=3001
NODE_ENV=production
EOF

    echo -e "${RED}⚠️  Please edit .env file with your actual API keys:${NC}"
    echo -e "   nano .env"
    echo -e "\nAfter setting up .env, run this script again."
    exit 1
fi

# Verify API keys are set
source .env
if [ -z "$OPENAI_API_KEY" ] || [ "$OPENAI_API_KEY" = "your-openai-api-key-here" ]; then
    echo -e "${RED}❌ OPENAI_API_KEY not configured in .env${NC}"
    exit 1
fi

if [ -z "$GOOGLE_SPEECH_API_KEY" ] && [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    echo -e "${RED}❌ Google Cloud credentials not configured in .env${NC}"
    echo -e "${YELLOW}Set either GOOGLE_SPEECH_API_KEY or GOOGLE_APPLICATION_CREDENTIALS${NC}"
    exit 1
fi

# Check PhraseSet configuration (optional but recommended)
if [ -n "$GOOGLE_PHRASE_SET_ID" ] && [ -n "$GOOGLE_CLOUD_PROJECT_ID" ]; then
    echo -e "${GREEN}✅ PhraseSet configured: $GOOGLE_PHRASE_SET_ID${NC}"
else
    echo -e "${YELLOW}⚠️  PhraseSet not configured (optional - improves recognition accuracy)${NC}"
fi

echo -e "${GREEN}✅ Environment variables configured${NC}"

# Check if app is already running
if pm2 list | grep -q "exbabel-backend"; then
    echo -e "\n${YELLOW}🔄 Restarting backend...${NC}"
    pm2 restart exbabel-backend
else
    echo -e "\n${YELLOW}🚀 Starting backend...${NC}"
    pm2 start server.js --name exbabel-backend
    pm2 save
fi

# Wait for startup
echo -e "\n${YELLOW}⏳ Waiting for backend to start...${NC}"
sleep 3

# Check status
pm2 status exbabel-backend

# Test health endpoint
echo -e "\n${YELLOW}🏥 Testing health endpoint...${NC}"
if curl -f http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Backend is running!${NC}"
else
    echo -e "${RED}❌ Health check failed${NC}"
    echo -e "${YELLOW}Check logs with: pm2 logs exbabel-backend${NC}"
    exit 1
fi

# Show logs
echo -e "\n${YELLOW}📋 Recent logs:${NC}"
pm2 logs exbabel-backend --lines 20 --nostream

# Summary
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}✅ Backend Update Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "\n${YELLOW}Useful commands:${NC}"
echo -e "  pm2 status                     - Check status"
echo -e "  pm2 logs exbabel-backend - View logs"
echo -e "  pm2 restart exbabel-backend - Restart"
echo -e "  pm2 stop exbabel-backend - Stop"
echo -e "  curl http://localhost:3001/health - Health check"
echo -e ""

