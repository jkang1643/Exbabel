MVP Implementation Plan: Robust Stateless Scalability
This plan enables multi-instance scaling with critical robustness for production (reconnects, heartbeats, correct routing).

User Review Required
IMPORTANT

Host Stickiness: The Host MUST stick to the same server (managed by Load Balancer). Heartbeat: Listeners rely on a Host Heartbeat in Redis to know if a session is alive. Sequence IDs: All events MUST have a monotonic seq ID per session for client-side deduplication.

Phase 1: Infrastructure & Discovery
1. Infrastructure
[NEW] backend/redis.js
Initialize and export three ioredis clients:

redis: General commands (SET/GET/INCR).
pub: For publishing events.
sub: For subscribing to channels.
2. Session Discovery (Hybrid Model)
[MODIFY] 
backend/sessionStore.js
The 
SessionStore
 manages discovery via Redis but keeps WebSocket references local.

Redis Keys:

session:code:{code} -> sessionId (TTL: 24h)
session:meta:{sessionId} -> Hash { hostNodeId, sourceLang, createdAt, status } (TTL: 24h)
session:host:{sessionId}:heartbeat -> 1 (TTL: 60s)
Key Method Changes:

createSession()
:
Generate hostNodeId (e.g., hostname + pid).
Write keys to Redis.
Start local Interval to refresh heartbeat key every 20s.
closeSession(sessionId)
:
New: Clear heartbeat interval.
New: DEL session:host:{id}:heartbeat
New: HSET session:meta:{id} status ended
getSession(sessionId)
:
Check Local Map first.
If missing, check Redis meta AND heartbeat.
If no heartbeat => Return null (Host Offline).
Else => Return "Remote Session Stub" (ONLY for joining/subscribing).
3. Event Broadcasting (Pub/Sub)
[MODIFY] 
backend/sessionStore.js
Use Ref-counted subscriptions to manage Redis load. Ensure consistent ordering.

Redis Keys:

Channel: channel:session:{sessionId}
State:

localListenerCounts: Map<sessionId, count>
redisSubscribedSessions: Set
sessionSequence: Map<sessionId, int> (Host only, starts at 0)
Key Method Changes:

broadcastToListeners(sessionId, data)
:
New: Increment sessionSequence for this ID.
New: Attach seq to data payload.
pub.publish('channel:session:'+sessionId, ...)
addListener(sessionId, ws)
:
Increment localListenerCounts.
If count === 1: sub.subscribe('channel:session:'+sessionId)
Add ws to local Map.
removeListener(sessionId, ws)
:
Decrement localListenerCounts.
If count === 0: sub.unsubscribe(...)
handleRedisMessage(channel, message):
Forward to all local sockets for that session.
4. Rate Limiting
[MODIFY] 
backend/rateLimiter.js
checkLimit(ip):
const result = await redis.incr('ratelimit:ip:'+ip)
if (result === 1) await redis.expire('ratelimit:ip:'+ip, 60)
Return { allowed: count <= limit, remaining }
Verification
Listener Reconnect: Disconnect listener, reconnect, ensure data resumes.
Host Disconnect: Kill host, ensure listener cannot re-join dead session (heartbeat check).
Scaling: Run 2 instances. Host on A, Listener on B. Verify message flow.
Deploy Restart: Restart listener node while host stays active. Listeners should reconnect and receive data.


The right order for your MVP (so you don’t overbuild)
Step 1 — Stateless runtime architecture (MVP scope)

Do this now:

Sticky host stream ownership (accept it)

Listener fan-out via Redis

Session discovery via Redis

Sequence IDs on events

Heartbeat so you don’t join dead sessions

This is “stateless enough to scale” and doesn’t require full DB modeling.

Step 2 — Minimal DB for MVP (only what you need)

Add DB only for things that must be durable:

Users (if you have accounts)

Subscriptions (if you’re charging)

Usage totals (monthly counters)

Final transcripts (optional but helpful)

That’s not “designing the whole DB,” it’s just enough to support production.

Step 3 — Expand DB model later

Once MVP is live:

usage events (audit trail)

invoices/webhook logs

feature overrides

richer session history, analytics, etc.