# Exbabel Networking Architecture Guide

**Complete explanation of how the networking is wired together**

---

## 🎯 Quick Overview

Your application has **two separate parts** that communicate:

1. **Frontend** (React app) → Served from **CloudFront CDN** (AWS)
2. **Backend** (Node.js API) → Running on **EC2 server** (AWS)

They talk to each other over HTTPS/WSS (secure connections).

---

## 📍 Domain Names & DNS Routing

### DNS Records (Route 53)

| Domain | Type | Points To | What It Serves |
|--------|------|-----------|----------------|
| `exbabel.com` | A (ALIAS) | `d16uzf3jkdukna.cloudfront.net` | Marketing/Landing page |
| `www.exbabel.com` | CNAME | `d16uzf3jkdukna.cloudfront.net` | Marketing (www) |
| `app.exbabel.com` | CNAME | `d16uzf3jkdukna.cloudfront.net` | **Frontend React App** |
| `api.exbabel.com` | A | `98.85.112.245` | **Backend API + WebSocket** |

### How DNS Works

```
User types: app.exbabel.com
    ↓
DNS lookup (Route 53)
    ↓
Returns: d16uzf3jkdukna.cloudfront.net (CloudFront CDN)
    ↓
User connects to CloudFront
    ↓
CloudFront serves frontend files from S3
```

```
User types: api.exbabel.com
    ↓
DNS lookup (Route 53)
    ↓
Returns: 98.85.112.245 (EC2 IP address)
    ↓
User connects directly to EC2 server
    ↓
Nginx reverse proxy forwards to Node.js
```

---

## 🏗️ Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S BROWSER                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            │
        ┌───────────────────┴───────────────────┐
        │                                         │
        ▼                                         ▼
┌───────────────────┐                  ┌───────────────────┐
│  app.exbabel.com  │                  │  api.exbabel.com  │
│  (Frontend)       │                  │  (Backend API)     │
└───────────────────┘                  └───────────────────┘
        │                                         │
        │ HTTPS                                   │ HTTPS/WSS
        │                                         │
        ▼                                         ▼
┌───────────────────┐                  ┌───────────────────┐
│   CloudFront CDN  │                  │   EC2 Server      │
│   (AWS CDN)      │                  │   IP: 98.85.112.245│
└───────────────────┘                  └───────────────────┘
        │                                         │
        │                                         │
        ▼                                         ▼
┌───────────────────┐                  ┌───────────────────┐
│   S3 Bucket       │                  │   Nginx           │
│   (Static Files)  │                  │   (Reverse Proxy) │
│   exbabelapp      │                  └───────────────────┘
└───────────────────┘                            │
                                                  │
                                                  │ Port 3001
                                                  ▼
                                         ┌───────────────────┐
                                         │   Node.js Backend │
                                         │   (server.js)     │
                                         │   - REST API      │
                                         │   - WebSocket     │
                                         └───────────────────┘
```

---

## 🌐 Frontend Flow (app.exbabel.com)

### Step-by-Step Request Flow

1. **User visits** `https://app.exbabel.com`
2. **DNS Resolution**: Route 53 returns CloudFront distribution
3. **CloudFront CDN**: 
   - Checks cache for files
   - If not cached, fetches from S3 bucket `exbabelapp`
   - Serves HTML, CSS, JavaScript files
4. **Browser loads React app**
5. **React app makes API calls** to `https://api.exbabel.com`

### Frontend Configuration

**Where it's built:**
- Local: `frontend/` directory
- Production: Built and uploaded to S3

**Environment variables** (set during build):
```bash
VITE_API_URL=https://api.exbabel.com
VITE_WS_URL=wss://api.exbabel.com/translate
VITE_APP_URL=https://app.exbabel.com
```

**Deployment process:**
```bash
cd frontend
npm run build          # Creates dist/ folder
aws s3 sync dist/ s3://exbabelapp/ --delete  # Upload to S3
aws cloudfront create-invalidation --distribution-id d16uzf3jkdukna --paths "/*"  # Clear cache
```

---

## 🔌 Backend Flow (api.exbabel.com)

### Step-by-Step Request Flow

1. **User/App makes request** to `https://api.exbabel.com/health`
2. **DNS Resolution**: Route 53 returns EC2 IP `98.85.112.245`
3. **Nginx** (port 443, HTTPS):
   - Receives HTTPS request
   - Uses Let's Encrypt SSL certificate
   - **Proxies to** `http://localhost:3001` (Node.js backend)
4. **Node.js Backend** (port 3001):
   - Handles the request
   - Returns response
5. **Nginx** forwards response back to client

### WebSocket Flow (Special Case)

1. **Client connects** to `wss://api.exbabel.com/api/translate`
2. **Nginx** receives WebSocket upgrade request
3. **Nginx configuration** (from `nginx.conf`):
   ```nginx
   # WebSocket upgrade headers
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection $connection_upgrade;
   ```
4. **Nginx proxies** WebSocket connection to `ws://localhost:3001`
5. **Node.js** handles WebSocket connection
6. **Bidirectional communication** established

### Backend Configuration

**Server location:**
- EC2 path: `/home/ec2-user/exbabel/backend/`
- Runs on: `localhost:3001` (internal)
- Exposed via: `api.exbabel.com:443` (external, HTTPS)

**Nginx config location:**
- `/etc/nginx/conf.d/exbabel.conf`

**Process manager:**
- PM2 runs Node.js backend
- Auto-restarts on crash
- Starts on server boot

---

## 🔒 CORS (Cross-Origin Resource Sharing)

### What is CORS?

CORS is a browser security feature. When your frontend (on `app.exbabel.com`) tries to make API calls to `api.exbabel.com`, the browser checks if the backend allows it.

### CORS Configuration in Backend

**Location:** `backend/server.js`

```javascript
// Frontend endpoints: allow frontend domains
app.use(cors({
  origin: [
    'http://localhost:3000',                        // Local development
    'https://exbabel.com',                          // Marketing site
    'https://www.exbabel.com',                      // Marketing www
    'https://app.exbabel.com',                      // Application frontend
    'https://d16uzf3jkdukna.cloudfront.net',       // CloudFront direct
    'http://app.exbabel.com'                        // HTTP fallback
  ],
  credentials: true
}));
```

### How CORS Works

1. **Browser sends preflight request** (OPTIONS) before actual request
2. **Backend responds** with allowed origins
3. **Browser checks** if frontend origin is in allowed list
4. **If allowed**, browser makes actual request
5. **If not allowed**, browser blocks the request (CORS error)

### API Endpoints (No CORS)

```javascript
// API endpoints: No CORS (or specific origins only)
app.use('/api', cors({
  origin: false, // No CORS for API endpoints (WebSocket doesn't use CORS anyway)
  credentials: false
}));
```

**Why?** WebSocket connections don't use CORS. They use the `Upgrade` header instead.

---

## 🔐 SSL/TLS Certificates

### Two Different SSL Certificates

#### 1. CloudFront SSL (Frontend)
- **Type:** AWS Certificate Manager (ACM)
- **Region:** `us-east-1` (required for CloudFront)
- **Covers:** 
  - `exbabel.com`
  - `www.exbabel.com`
  - `app.exbabel.com`
- **Managed by:** AWS (auto-renewal)
- **Used by:** CloudFront distribution

#### 2. EC2 SSL (Backend)
- **Type:** Let's Encrypt (Certbot)
- **Domain:** `api.exbabel.com`
- **Location:** `/etc/letsencrypt/live/api.exbabel.com/`
- **Renewal:** Automatic (systemd timer)
- **Used by:** Nginx on EC2

### Why Two Certificates?

- **CloudFront** needs ACM certificate (AWS requirement)
- **EC2** uses Let's Encrypt (free, easy to set up)
- They're separate because they're on different services

---

## 🔄 Request Flow Examples

### Example 1: User Opens App

```
1. User types: https://app.exbabel.com
   ↓
2. DNS: app.exbabel.com → d16uzf3jkdukna.cloudfront.net
   ↓
3. CloudFront: Serves index.html from S3 cache
   ↓
4. Browser: Loads React app
   ↓
5. React: Makes API call to https://api.exbabel.com/health
   ↓
6. DNS: api.exbabel.com → 98.85.112.245
   ↓
7. Nginx: Receives HTTPS request, proxies to localhost:3001
   ↓
8. Node.js: Returns {"status": "ok"}
   ↓
9. Nginx: Forwards response back
   ↓
10. Browser: Receives response, app works!
```

### Example 2: WebSocket Connection

```
1. React app: Connects to wss://api.exbabel.com/api/translate
   ↓
2. DNS: api.exbabel.com → 98.85.112.245
   ↓
3. Nginx: Receives WebSocket upgrade request
   ↓
4. Nginx: Adds Upgrade headers, proxies to ws://localhost:3001
   ↓
5. Node.js: Accepts WebSocket connection
   ↓
6. Bidirectional connection established
   ↓
7. Client ↔ Server: Can send/receive messages in real-time
```

### Example 3: API Call with CORS

```
1. React app (app.exbabel.com): fetch('https://api.exbabel.com/session/start')
   ↓
2. Browser: Sends preflight OPTIONS request
   ↓
3. Backend: Checks CORS config
   ↓
4. Backend: Returns Access-Control-Allow-Origin: https://app.exbabel.com
   ↓
5. Browser: ✅ Origin allowed, makes actual POST request
   ↓
6. Backend: Processes request, returns response
   ↓
7. Browser: Receives response, app continues
```

---

## 🛠️ Nginx Reverse Proxy Explained

### What is a Reverse Proxy?

Nginx sits in front of Node.js and:
- Handles SSL/TLS termination (decrypts HTTPS)
- Routes requests to Node.js
- Handles WebSocket upgrades
- Adds security headers

### Nginx Configuration Breakdown

```nginx
# HTTP → HTTPS redirect
server {
    listen 80;
    server_name api.exbabel.com;
    return 301 https://$server_name$request_uri;  # Force HTTPS
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name api.exbabel.com;
    
    # SSL certificate
    ssl_certificate /etc/letsencrypt/live/api.exbabel.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.exbabel.com/privkey.pem;
    
    # Proxy ALL requests to Node.js
    location / {
        proxy_pass http://localhost:3001;  # Forward to Node.js
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        
        # Standard headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Why Use Nginx?

1. **SSL Termination**: Handles HTTPS, Node.js only sees HTTP
2. **Security**: Adds security headers, rate limiting
3. **WebSocket Support**: Properly handles WebSocket upgrades
4. **Performance**: Can serve static files, caching
5. **Port Management**: Exposes port 443 (HTTPS) instead of 3001

---

## 📡 Ports & Protocols

### Ports Used

| Service | Port | Protocol | Access |
|---------|------|----------|--------|
| **Nginx** | 443 | HTTPS | Public (api.exbabel.com) |
| **Nginx** | 80 | HTTP | Public (redirects to 443) |
| **Node.js** | 3001 | HTTP | Local only (localhost) |
| **CloudFront** | 443 | HTTPS | Public (app.exbabel.com) |

### Why Node.js Runs on Port 3001?

- **Internal only**: Not exposed to internet
- **Nginx proxies**: External traffic comes through Nginx (port 443)
- **Security**: Node.js doesn't need to handle SSL directly
- **Flexibility**: Can run multiple Node.js apps on different ports

---

## 🔍 How to Debug Networking Issues

### Check DNS Resolution

```bash
# Check if DNS is working
nslookup api.exbabel.com
# Should return: 98.85.112.245

nslookup app.exbabel.com
# Should return: d16uzf3jkdukna.cloudfront.net
```

### Check Backend is Running

```bash
# On EC2 server
curl http://localhost:3001/health
# Should return: {"status":"ok"}

# From your computer
curl https://api.exbabel.com/health
# Should return: {"status":"ok"}
```

### Check CORS Headers

```bash
# Check CORS is working
curl -I https://api.exbabel.com/health
# Should show: Access-Control-Allow-Origin: https://app.exbabel.com
```

### Check WebSocket Connection

```bash
# Test WebSocket (requires wscat)
wscat -c wss://api.exbabel.com/api/translate?apiKey=your-key
```

### Check Nginx Status

```bash
# On EC2
sudo nginx -t          # Test config
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```

### Check Node.js Status

```bash
# On EC2
pm2 status
pm2 logs exbabel-backend
```

---

## 🎯 Key Takeaways

1. **Frontend** = CloudFront + S3 (static files, CDN)
2. **Backend** = EC2 + Nginx + Node.js (API, WebSocket)
3. **CORS** = Backend allows specific origins to make requests
4. **Nginx** = Reverse proxy that handles SSL and routes to Node.js
5. **WebSocket** = Uses Upgrade header, not CORS
6. **Two SSL certs** = One for CloudFront (ACM), one for EC2 (Let's Encrypt)
7. **Port 3001** = Internal only, not exposed to internet
8. **Port 443** = Public HTTPS endpoint via Nginx

---

## 📚 Related Files

- **DNS Config**: `DNS_CONFIGURATION.md`
- **Nginx Config**: `nginx.conf`
- **Backend CORS**: `backend/server.js` (lines 40-59)
- **WebSocket Guide**: `WEBSOCKET_API_GUIDE.md`

---

**Last Updated:** 2025-01-20  
**Status:** ✅ Production Architecture
