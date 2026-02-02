# Auth + Membership UX - Manual Testing Guide

## Prerequisites

1. **Start servers:**
   ```bash
   npm run dev
   ```
   - Backend: http://localhost:3001
   - Frontend: http://localhost:5173

2. **Required env vars:**
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `frontend/.env.local`
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`

3. **Test accounts:** Prepare email accounts for testing (can use +suffix for Gmail)

---

## Test 1: Anonymous User Flow (No Login)

### 1.1 Landing Page (VisitorHome)
- [ ] Open http://localhost:5173
- [ ] Verify VisitorHome displays with:
  - "Real-Time Translation" hero text
  - Session code input (prominent)
  - "Join a Church" card
  - "Create a Church" card
  - "Sign In" button in header

### 1.2 Join Session as Anonymous
- [ ] Enter a valid session code (if you have one running)
- [ ] Click "Join Session"
- [ ] Verify ListenerPage loads with language selection
- [ ] Verify WebSocket connects and translations appear (if host is active)
- [ ] Click back → should return to VisitorHome

### 1.3 Navigate to Join Church (Unauthenticated)
- [ ] Click "Join a Church" card
- [ ] Verify JoinChurchPage loads with:
  - Search input
  - List of churches (if any exist)
- [ ] Try clicking "Join" on a church
- [ ] Verify error message: "Please sign in to join a church"

---

## Test 2: Sign Up / Sign In Flow

### 2.1 Email Sign Up
- [ ] Click "Sign In" button
- [ ] Click "Sign up" link (if shown)
- [ ] Enter email and password
- [ ] Click "Sign Up"
- [ ] Verify confirmation email is sent (check Supabase dashboard or email)
- [ ] Confirm email and sign in

### 2.2 Email Sign In
- [ ] From VisitorHome, click "Sign In"
- [ ] Enter valid email/password
- [ ] Click "Sign In"
- [ ] Verify redirect to VisitorHome (since no profile yet)
- [ ] Verify "Signed in as {email}" message appears

### 2.3 Google OAuth (if configured)
- [ ] From LoginPage, click "Continue with Google"
- [ ] Complete Google OAuth flow
- [ ] Verify redirect back to app
- [ ] Verify signed in state

---

## Test 3: Visitor State (Signed In, No Profile)

### 3.1 Verify Visitor State
- [ ] Sign in with an account that has NO profile in the database
- [ ] Verify VisitorHome displays (not AdminHome or MemberHome)
- [ ] Verify user email shown at bottom

### 3.2 Join Session with Auto-Link
- [ ] Create a session from an Admin account (or use existing)
- [ ] As the visitor, enter the session code and join
- [ ] Verify:
  - Session joins successfully
  - Alert/toast shows: "Welcome! You've joined {Church Name}"
- [ ] Go back to home
- [ ] Verify user now sees **MemberHome** (they've been auto-linked!)

### 3.3 Join Church Directly
- [ ] Sign in as a NEW visitor (no profile)
- [ ] Click "Join a Church"
- [ ] Search for a church name
- [ ] Click "Join" button
- [ ] Verify success message: "Welcome to {Church Name}!"
- [ ] Verify redirect to home shows **MemberHome**

---

## Test 4: Member State (Has Profile, role=member)

### 4.1 Verify Member Home
- [ ] Sign in as user with `role = 'member'`
- [ ] Verify MemberHome displays with:
  - "Welcome back!" greeting
  - Solo Mode card
  - Join Session card
  - User email shown
  - Sign out link

### 4.2 Solo Mode Access
- [ ] Click "Start Solo Session"
- [ ] Verify SoloPage loads correctly
- [ ] Verify can start recording/translation
- [ ] Click back → returns to MemberHome

### 4.3 Join Session
- [ ] Click "Enter Session Code"
- [ ] Enter a valid session code
- [ ] Click "Join"
- [ ] Verify ListenerPage loads

### 4.4 Verify No Host Access
- [ ] Try navigating directly to host mode (shouldn't be possible from UI)
- [ ] Verify no "Host" option visible for members

---

## Test 5: Admin State (Has Profile, role=admin)

### 5.1 Verify Admin Home
- [ ] Sign in as user with `role = 'admin'`
- [ ] Verify AdminHome displays with:
  - "Admin Dashboard 👑" title
  - **Host a Live Session** card (prominent, red button)
  - Solo Mode card
  - Join Session card
  - Analytics placeholder

### 5.2 Host Session
- [ ] Click "Start Broadcasting"
- [ ] Verify HostPage loads
- [ ] Verify session code displayed
- [ ] Verify can start recording
- [ ] End session and return to home

### 5.3 Solo Mode (Admin)
- [ ] Click "Start Solo"
- [ ] Verify SoloPage works as expected

### 5.4 Join Session (Admin)
- [ ] Click "Enter Code" on Join Session card
- [ ] Enter another session's code
- [ ] Verify can join as listener

---

## Test 6: API Endpoint Testing (curl)

### 6.1 Church Search (Public)
```bash
# List all churches
curl http://localhost:3001/api/churches/search

# Search by name
curl "http://localhost:3001/api/churches/search?q=test"
```
- [ ] Verify returns `{ success: true, churches: [...], count: N }`

### 6.2 Church Join (Requires Auth)
```bash
# Without token - should fail
curl -X POST http://localhost:3001/api/churches/join \
  -H "Content-Type: application/json" \
  -d '{"churchId": "YOUR_CHURCH_UUID"}'

# With token
curl -X POST http://localhost:3001/api/churches/join \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"churchId": "YOUR_CHURCH_UUID"}'
```
- [ ] Without token: 401 error
- [ ] With token (no profile): Creates profile, returns success
- [ ] With token (existing profile same church): Returns "already member"
- [ ] With token (existing profile diff church): Returns error

### 6.3 User Context (/api/me)
```bash
# No token
curl http://localhost:3001/api/me

# With token (no profile)
curl http://localhost:3001/api/me \
  -H "Authorization: Bearer YOUR_TOKEN"

# With token (has profile)
curl http://localhost:3001/api/me \
  -H "Authorization: Bearer YOUR_TOKEN"
```
- [ ] No token: 401 error
- [ ] Token no profile: `{ profile: null, isVisitor: true, ... }`
- [ ] Token with profile: `{ profile: { user_id, church_id, role }, ... }`

---

## Test 7: Edge Cases

### 7.1 Deep Link / QR Code Join
- [ ] Navigate to: `http://localhost:5173/?join=ABC123`
- [ ] Verify auto-redirects to ListenerPage with code pre-filled

### 7.2 Session Expiry / Token Refresh
- [ ] Sign in and wait for token to near expiry
- [ ] Verify auto-refresh works (or re-login prompt)

### 7.3 Network Errors
- [ ] Stop backend, try to join session
- [ ] Verify appropriate error message displayed

### 7.4 Invalid Session Code
- [ ] Enter invalid code (e.g., "XXXXXX")
- [ ] Verify error: "Session not found" or similar

### 7.5 User Already Member of Different Church
- [ ] Sign in as user with existing profile (church A)
- [ ] Try to join church B via JoinChurchPage
- [ ] Verify error: "You are already a member of another church"

---

## Test 8: Sign Out Flow

### 8.1 Sign Out from Each Home
- [ ] **AdminHome**: Click "Sign out" → verify returns to VisitorHome
- [ ] **MemberHome**: Click "Sign out" → verify returns to VisitorHome
- [ ] Verify session cleared (refresh shows VisitorHome)

---

## Database Verification (Optional)

```sql
-- Check profiles table after tests
SELECT user_id, church_id, role, created_at 
FROM profiles 
ORDER BY created_at DESC 
LIMIT 10;

-- Check churches
SELECT id, name, created_at FROM churches;

-- Check sessions  
SELECT id, session_code, church_id, status 
FROM sessions 
WHERE status = 'active';
```

---

## Results Summary

| Test | Status | Notes |
|------|--------|-------|
| 1.1 VisitorHome Display | ⬜ | |
| 1.2 Anonymous Join Session | ⬜ | |
| 1.3 Join Church (Unauth) | ⬜ | |
| 2.1 Email Sign Up | ⬜ | |
| 2.2 Email Sign In | ⬜ | |
| 2.3 Google OAuth | ⬜ | |
| 3.1 Visitor State | ⬜ | |
| 3.2 Auto-Link on Join | ⬜ | |
| 3.3 Join Church Directly | ⬜ | |
| 4.1 MemberHome Display | ⬜ | |
| 4.2 Member Solo Mode | ⬜ | |
| 4.3 Member Join Session | ⬜ | |
| 5.1 AdminHome Display | ⬜ | |
| 5.2 Admin Host Session | ⬜ | |
| 5.3 Admin Solo Mode | ⬜ | |
| 5.4 Admin Join Session | ⬜ | |
| 6.1-6.3 API Endpoints | ⬜ | |
| 7.1-7.5 Edge Cases | ⬜ | |
| 8.1 Sign Out | ⬜ | |
