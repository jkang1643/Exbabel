#!/bin/bash

# Exbabel - Frontend Deployment Script for AWS S3 + CloudFront
# This script builds and deploys the frontend to S3 and invalidates CloudFront cache

set -e  # Exit on error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Exbabel Frontend Deployment${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Please install it first.${NC}"
    exit 1
fi

# Configuration
read -p "Enter your S3 bucket name: " S3_BUCKET
read -p "Enter your CloudFront distribution ID (press Enter to skip cache invalidation): " CLOUDFRONT_ID
read -p "Enter your EC2 public IP or domain: " BACKEND_URL

if [ -z "$S3_BUCKET" ]; then
    echo -e "${RED}❌ S3 bucket name is required${NC}"
    exit 1
fi

if [ -z "$BACKEND_URL" ]; then
    echo -e "${RED}❌ Backend URL is required${NC}"
    exit 1
fi

# Create production environment file
echo -e "\n${YELLOW}📝 Creating production environment configuration...${NC}"
cd frontend

cat > .env.production << EOF
# Backend API URL
VITE_API_URL=http://${BACKEND_URL}

# Backend WebSocket URL
VITE_WS_URL=ws://${BACKEND_URL}/translate

# If using HTTPS/WSS, use:
# VITE_API_URL=https://${BACKEND_URL}
# VITE_WS_URL=wss://${BACKEND_URL}/translate

# Feature Flags
VITE_TTS_UI_ENABLED=true
VITE_USE_SHARED_ENGINE=false
EOF

echo -e "${GREEN}✅ Environment configuration created${NC}"

# Install dependencies
echo -e "\n${YELLOW}📦 Installing dependencies...${NC}"
npm install

# Build frontend
echo -e "\n${YELLOW}🔨 Building frontend for production...${NC}"
npm run build

if [ ! -d "dist" ]; then
    echo -e "${RED}❌ Build failed - dist directory not found${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build complete${NC}"

# Upload to S3
echo -e "\n${YELLOW}☁️  Uploading to S3: ${S3_BUCKET}...${NC}"

# Upload assets with long cache
aws s3 sync dist/ s3://${S3_BUCKET}/ \
  --delete \
  --cache-control "public, max-age=31536000" \
  --exclude "*.html" \
  --exclude "index.html"

# Upload HTML with short cache
aws s3 sync dist/ s3://${S3_BUCKET}/ \
  --exclude "*" \
  --include "*.html" \
  --cache-control "public, max-age=0, must-revalidate"

echo -e "${GREEN}✅ Upload complete${NC}"

# Invalidate CloudFront cache
if [ ! -z "$CLOUDFRONT_ID" ]; then
    echo -e "\n${YELLOW}🔄 Invalidating CloudFront cache...${NC}"
    
    INVALIDATION_ID=$(aws cloudfront create-invalidation \
        --distribution-id ${CLOUDFRONT_ID} \
        --paths "/*" \
        --query 'Invalidation.Id' \
        --output text)
    
    echo -e "${GREEN}✅ Cache invalidation created: ${INVALIDATION_ID}${NC}"
    echo -e "${YELLOW}ℹ️  It may take 5-10 minutes to complete${NC}"
else
    echo -e "\n${YELLOW}⚠️  Skipping CloudFront cache invalidation${NC}"
fi

# Get S3 website URL
REGION=$(aws s3api get-bucket-location --bucket ${S3_BUCKET} --query 'LocationConstraint' --output text)
if [ "$REGION" = "None" ] || [ -z "$REGION" ]; then
    REGION="us-east-1"
fi

S3_WEBSITE_URL="http://${S3_BUCKET}.s3-website-${REGION}.amazonaws.com"

# Summary
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "S3 Bucket: ${S3_BUCKET}"
echo -e "S3 Website URL: ${S3_WEBSITE_URL}"

if [ ! -z "$CLOUDFRONT_ID" ]; then
    # Get CloudFront domain
    CF_DOMAIN=$(aws cloudfront get-distribution \
        --id ${CLOUDFRONT_ID} \
        --query 'Distribution.DomainName' \
        --output text)
    echo -e "CloudFront URL: https://${CF_DOMAIN}"
fi

echo -e "\n${YELLOW}Next steps:${NC}"
echo -e "1. Test your deployment at the CloudFront URL"
echo -e "2. Check browser console for any errors"
echo -e "3. Test microphone and translation features"
echo -e ""

