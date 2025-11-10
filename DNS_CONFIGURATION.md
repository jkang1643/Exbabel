# Exbabel DNS & Domain Configuration

**Last Updated:** October 27, 2025  
**Domain:** exbabel.com  
**Architecture:** CloudFront + S3 (Frontend) + EC2 (Backend API)

---

## Current DNS Configuration (Route 53)

### Production Setup

| Record Name | Type | Value | Purpose |
|------------|------|-------|---------|
| `exbabel.com` | A (ALIAS) | `d16uzf3jkdukna.cloudfront.net` | Marketing/Landing page |
| `www.exbabel.com` | CNAME | `d16uzf3jkdukna.cloudfront.net` | Marketing (www redirect) |
| `app.exbabel.com` | CNAME | `d16uzf3jkdukna.cloudfront.net` | Application Frontend (React) |
| `api.exbabel.com` | A | `98.85.112.245` | Backend API + WebSocket |

### Other Records (Keep As-Is)

| Record Name | Type | Value | Purpose |
|------------|------|-------|---------|
| `exbabel.com` | MX | `10 mx00.ionos.com.` `10 mx01.ionos.com.` | Email routing |
| `exbabel.com` | NS | AWS nameservers | DNS delegation |
| `exbabel.com` | SOA | AWS SOA record | DNS zone info |
| `exbabel.com` | TXT | SPF record | Email validation |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    USER TRAFFIC                         │
└─────────────────────────────────────────────────────────┘
                           ↓
                 ┌─────────┴─────────┐
                 ↓                   ↓
         
    exbabel.com              app.exbabel.com
    www.exbabel.com          (Application)
    (Marketing)
         ↓                          ↓
    ┌────────────────────────────────────────┐
    │  CloudFront Distribution               │
    │  ID: d16uzf3jkdukna                    │
    │  SSL: ACM Certificate (us-east-1)      │
    └────────────────────────────────────────┘
                     ↓
    ┌────────────────────────────────────────┐
    │  S3 Bucket: exbabelapp                 │
    │  - Frontend static files (HTML/JS/CSS) │
    │  - Marketing pages                      │
    └────────────────────────────────────────┘
                     ↓
            (Makes API calls to)
                     ↓
         api.exbabel.com (98.85.112.245)
                     ↓
    ┌────────────────────────────────────────┐
    │  EC2 Instance                          │
    │  - Nginx (reverse proxy)               │
    │  - Let's Encrypt SSL                   │
    │  - Node.js Backend (port 3001)         │
    │  - REST API + WebSocket                │
    └────────────────────────────────────────┘
```

---

## SSL Certificates

### 1. ACM Certificate (for CloudFront)

**Region:** us-east-1 (REQUIRED for CloudFront)  
**Covers:**
- `exbabel.com`
- `www.exbabel.com`
- `app.exbabel.com`

**Type:** AWS Certificate Manager (ACM)  
**Validation:** DNS (automatic via Route 53)  
**Renewal:** Automatic by AWS  
**Used by:** CloudFront distribution

**How to check:**
```bash
aws acm list-certificates --region us-east-1
```

### 2. Let's Encrypt Certificate (for EC2)

**Domain:** `api.exbabel.com`  
**Type:** Let's Encrypt (Certbot)  
**Location:** `/etc/letsencrypt/live/api.exbabel.com/`  
**Renewal:** Automatic (systemd timer)  
**Used by:** Nginx on EC2

**How to check (on EC2):**
```bash
sudo certbot certificates
sudo systemctl status certbot-renew.timer
```

---

## What Changed from Previous Setup

### Before (Self-Signed SSL Demo)

```
❌ app.exbabel.com  →  A  →  98.85.112.245 (EC2)
   - Self-signed SSL certificate
   - Browser security warnings
   - Frontend served from EC2
   - Hardcoded URLs in .env.production
```

### After (Current Production Setup)

```
✅ app.exbabel.com  →  CNAME  →  CloudFront  →  S3
   - Trusted SSL (ACM)
   - No browser warnings
   - CDN distribution
   - Dynamic URLs

✅ api.exbabel.com  →  A  →  98.85.112.245 (EC2)
   - Let's Encrypt SSL
   - Backend API only
   - WebSocket support
```

**Key Changes:**
1. ✅ Removed hardcoded `.env.production` file
2. ✅ Separated frontend (CloudFront) from backend (EC2)
3. ✅ Added `api.exbabel.com` subdomain for backend
4. ✅ CloudFront serves all frontend traffic
5. ✅ Backend CORS updated to allow CloudFront origins

---

## CloudFront Configuration

**Distribution ID:** `d16uzf3jkdukna`

### Settings:

| Setting | Value |
|---------|-------|
| **Origin** | `exbabelapp.s3.amazonaws.com` |
| **Alternate Domain Names** | `exbabel.com`, `www.exbabel.com`, `app.exbabel.com` |
| **SSL Certificate** | Custom ACM certificate |
| **Viewer Protocol Policy** | Redirect HTTP to HTTPS |
| **Default Root Object** | `index.html` |
| **Price Class** | Use All Edge Locations (best performance) |

### How to Update:

```bash
# Invalidate cache after deploying new frontend
aws cloudfront create-invalidation \
  --distribution-id d16uzf3jkdukna \
  --paths "/*"
```

---

## Backend Configuration (EC2)

**Instance IP:** `98.85.112.245`  
**Domain:** `api.exbabel.com`  
**SSL:** Let's Encrypt (auto-renewing)

### Nginx Config Location:
```
/etc/nginx/conf.d/exbabel.conf
```

### Backend Code Location:
```
/home/ec2-user/exbabel/backend/
```

### CORS Allowed Origins:
- `http://localhost:3000` (development)
- `https://exbabel.com` (marketing)
- `https://www.exbabel.com` (marketing www)
- `https://app.exbabel.com` (application)
- `https://d16uzf3jkdukna.cloudfront.net` (CloudFront direct)

### API Endpoints:
- `https://api.exbabel.com/health` - Health check
- `https://api.exbabel.com/session/start` - Create session
- `https://api.exbabel.com/session/join` - Join session
- `wss://api.exbabel.com/translate` - WebSocket endpoint

---

## Frontend Deployment Process

### 1. Build Frontend

```bash
cd frontend

# Create production environment file
cat > .env.production << EOF
VITE_API_URL=https://api.exbabel.com
VITE_WS_URL=wss://api.exbabel.com/translate
VITE_APP_URL=https://app.exbabel.com
EOF

# Build
npm run build
```

### 2. Deploy to S3

```bash
# Sync to S3 bucket
aws s3 sync dist/ s3://exbabelapp/ --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id d16uzf3jkdukna \
  --paths "/*"
```

### 3. Verify Deployment

```bash
# Check S3 bucket
aws s3 ls s3://exbabelapp/

# Check CloudFront invalidation status
aws cloudfront list-invalidations \
  --distribution-id d16uzf3jkdukna
```

---

## How to Add a New Subdomain

### Example: Adding `staging.exbabel.com`

#### 1. Update Route 53

**For Frontend (CloudFront):**
```
Type: CNAME
Name: staging.exbabel.com
Value: d16uzf3jkdukna.cloudfront.net
TTL: 300
```

**For Backend (EC2):**
```
Type: A
Name: api-staging.exbabel.com
Value: 98.85.112.245
TTL: 300
```

#### 2. Update ACM Certificate

Request new certificate or add to existing:
```bash
aws acm request-certificate \
  --domain-name staging.exbabel.com \
  --validation-method DNS \
  --region us-east-1
```

Validate via Route 53 and attach to CloudFront.

#### 3. Update CloudFront

Add `staging.exbabel.com` to **Alternate Domain Names (CNAMEs)**

#### 4. Update Backend SSL (if needed)

On EC2:
```bash
sudo certbot certonly --standalone -d api-staging.exbabel.com
```

Update Nginx config to include new domain.

#### 5. Update Backend CORS

Add `https://staging.exbabel.com` to allowed origins in `backend/server.js`

---

## Changing Backend Domain

### If you need to move backend to a different domain:

#### Example: `api.exbabel.com` → `backend.exbabel.com`

1. **Update Route 53:**
   ```
   Delete: api.exbabel.com  A  98.85.112.245
   Create: backend.exbabel.com  A  98.85.112.245
   ```

2. **Get new SSL certificate (EC2):**
   ```bash
   sudo certbot certonly --standalone -d backend.exbabel.com
   ```

3. **Update Nginx config:**
   ```bash
   sudo nano /etc/nginx/conf.d/exbabel.conf
   # Change server_name from api.exbabel.com to backend.exbabel.com
   # Update ssl_certificate paths
   ```

4. **Rebuild frontend with new backend URL:**
   ```bash
   # Update .env.production
   VITE_API_URL=https://backend.exbabel.com
   VITE_WS_URL=wss://backend.exbabel.com/translate
   
   npm run build
   aws s3 sync dist/ s3://exbabelapp/ --delete
   ```

5. **Update backend CORS** (if origin domains stay the same, no change needed)

---

## Changing Frontend Domain

### If you need to move frontend to a different domain:

#### Example: `app.exbabel.com` → `translate.exbabel.com`

1. **Update Route 53:**
   ```
   Delete: app.exbabel.com  CNAME  d16uzf3jkdukna.cloudfront.net
   Create: translate.exbabel.com  CNAME  d16uzf3jkdukna.cloudfront.net
   ```

2. **Update ACM certificate:**
   - Add `translate.exbabel.com` to existing certificate, OR
   - Request new certificate with new domain

3. **Update CloudFront:**
   - Add `translate.exbabel.com` to Alternate Domain Names
   - Remove `app.exbabel.com` if no longer needed

4. **Update backend CORS:**
   ```javascript
   // In backend/server.js
   app.use(cors({
     origin: [
       'https://translate.exbabel.com',  // NEW
       // Remove or keep old domains as needed
     ]
   }));
   ```

5. **Restart backend:**
   ```bash
   pm2 restart exbabel-backend
   ```

---

## Troubleshooting

### DNS Not Resolving

**Check propagation:**
```bash
nslookup app.exbabel.com
dig app.exbabel.com
```

**Wait:** DNS changes can take 5-30 minutes to propagate

**Flush local DNS cache:**
```bash
# Windows
ipconfig /flushdns

# Mac
sudo dscacheutil -flushcache

# Linux
sudo systemd-resolve --flush-caches
```

### SSL Certificate Errors

**CloudFront SSL:**
- Must use ACM certificate in **us-east-1** region
- Certificate must be "Issued" status
- Domain names must match CloudFront CNAMEs exactly

**EC2 SSL:**
```bash
# Check certificate expiry
sudo certbot certificates

# Manually renew if needed
sudo certbot renew

# Check nginx config
sudo nginx -t
```

### CloudFront Serving Old Content

**Invalidate cache:**
```bash
aws cloudfront create-invalidation \
  --distribution-id d16uzf3jkdukna \
  --paths "/*"
```

**Wait 2-5 minutes** for invalidation to complete

### API Calls Failing (CORS Errors)

**Check backend CORS:**
```bash
# On EC2
grep -A 10 "cors" ~/exbabel/backend/server.js
```

**Restart backend:**
```bash
pm2 restart exbabel-backend
pm2 logs exbabel-backend
```

**Test API directly:**
```bash
curl -I https://api.exbabel.com/health
# Should show: Access-Control-Allow-Origin header
```

---

## Emergency Rollback

### If something breaks and you need to quickly revert:

#### Option 1: Point frontend back to EC2 (temporary)

```bash
# In Route 53, change:
app.exbabel.com  CNAME  →  A  98.85.112.245

# On EC2, restore frontend serving in Nginx
# (Use nginx.conf from git history)
```

#### Option 2: Revert to previous CloudFront deployment

```bash
# Deploy previous version from S3 backup or git history
git checkout <previous-commit>
cd frontend
npm run build
aws s3 sync dist/ s3://exbabelapp/ --delete
```

---

## Useful Commands Reference

### DNS & Routing
```bash
# Check DNS
nslookup exbabel.com
dig app.exbabel.com
whois exbabel.com

# List Route 53 hosted zones
aws route53 list-hosted-zones

# List records in hosted zone
aws route53 list-resource-record-sets --hosted-zone-id <ZONE_ID>
```

### CloudFront
```bash
# List distributions
aws cloudfront list-distributions

# Get distribution config
aws cloudfront get-distribution --id d16uzf3jkdukna

# Create invalidation
aws cloudfront create-invalidation \
  --distribution-id d16uzf3jkdukna \
  --paths "/*"

# List invalidations
aws cloudfront list-invalidations --distribution-id d16uzf3jkdukna
```

### S3
```bash
# List bucket contents
aws s3 ls s3://exbabelapp/

# Sync local to S3
aws s3 sync dist/ s3://exbabelapp/ --delete

# Download from S3
aws s3 sync s3://exbabelapp/ ./backup/
```

### SSL Certificates
```bash
# List ACM certificates (CloudFront - must be us-east-1)
aws acm list-certificates --region us-east-1

# Check Let's Encrypt certificates (EC2)
sudo certbot certificates

# Test SSL certificate
openssl s_client -connect api.exbabel.com:443 -servername api.exbabel.com
```

### EC2 Backend
```bash
# SSH to EC2
ssh -i your-key.pem ec2-user@98.85.112.245

# Check backend status
pm2 status
pm2 logs exbabel-backend

# Restart services
sudo systemctl restart nginx
pm2 restart exbabel-backend

# Check nginx
sudo nginx -t
sudo systemctl status nginx
```

---

## Contact & Support

**Repository:** https://github.com/jkang1643/Exbabel  
**AWS Account:** (Your AWS account ID)  
**Domain Registrar:** (Your domain registrar)  
**DNS Provider:** AWS Route 53

---

## Version History

| Date | Change | Reason |
|------|--------|--------|
| 2025-10-27 | Initial production setup | Separated frontend (CloudFront) from backend (EC2) |
| 2025-10-27 | Added `api.exbabel.com` | Backend API subdomain with Let's Encrypt SSL |
| 2025-10-27 | Removed self-signed SSL | Replaced with trusted certificates (ACM + Let's Encrypt) |

---

**Last Verified:** October 27, 2025  
**Status:** ✅ Production Ready

