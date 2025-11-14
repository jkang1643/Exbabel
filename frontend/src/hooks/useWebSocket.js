import { useState, useEffect, useRef, useCallback } from 'react'
import { flushSync } from 'react-dom'

export function useWebSocket(url) {
  const [connectionState, setConnectionState] = useState('connecting')
  const wsRef = useRef(null)
  const messageHandlersRef = useRef(new Set())
  const pingIntervalRef = useRef(null)
  const PING_INTERVAL = 10000 // 10 seconds

  const connect = useCallback(() => {
    // Close existing connection if any
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        console.log('[WebSocket] Already connected')
        return
      }
      wsRef.current.close()
    }

    console.log(`[WebSocket] Connecting to: ${url}`)
    
    try {
      wsRef.current = new WebSocket(url)
      
      wsRef.current.onopen = () => {
        setConnectionState('open')
        console.log('[WebSocket] ✅ Connected successfully!')
        
        // Start keep-alive ping interval (10s)
        pingIntervalRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
            console.log('[WebSocket] 📡 Keep-alive ping sent')
          }
        }, PING_INTERVAL)
      }
      
      wsRef.current.onclose = (event) => {
        setConnectionState('closed')
        console.log(`[WebSocket] ❌ Disconnected (code: ${event.code}, reason: ${event.reason})`)
        
        // Clear keep-alive ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current)
          pingIntervalRef.current = null
        }
        
        // Auto-reconnect after 2 seconds
        setTimeout(() => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) {
            console.log('[WebSocket] Attempting to reconnect...')
            connect()
          }
        }, 2000)
      }
      
      wsRef.current.onerror = (error) => {
        setConnectionState('error')
        // Extract more details from the error event
        const errorDetails = {
          type: error.type,
          target: error.target,
          readyState: wsRef.current?.readyState,
          url: wsRef.current?.url
        }
        console.error('[WebSocket] ⚠️ Error:', errorDetails)
        console.error('[WebSocket] Error event:', error)
        
        // Log WebSocket state for debugging
        if (wsRef.current) {
          console.error('[WebSocket] WebSocket state:', {
            readyState: wsRef.current.readyState,
            url: wsRef.current.url,
            protocol: wsRef.current.protocol,
            extensions: wsRef.current.extensions
          })
        }
      }
      
      wsRef.current.onmessage = (event) => {
        // Check if data is a string (JSON) or Blob
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data)
            // Log partial updates for debugging
            if (message.type === 'translation' && message.isPartial) {
              console.log(`[WebSocket] 📥 RECEIVED PARTIAL: "${(message.originalText || message.translatedText).substring(0, 30)}..."`)
            }
            // CRITICAL OPTIMIZATION: Use flushSync to bypass React batching
            // This ensures EVERY delta is rendered immediately (5-10/sec)
            // Instead of batching 5-10 deltas into 1-2 renders
            messageHandlersRef.current.forEach(handler => {
              try {
                flushSync(() => handler(message))
              } catch (error) {
                console.error('Message handler error:', error)
              }
            })
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error)
            console.error('Received data:', event.data.substring(0, 100))
          }
        } else {
          // Skip Blob or other non-string messages
          console.warn('Received non-string WebSocket message (Blob/Binary), skipping...')
        }
      }
    } catch (error) {
      setConnectionState('error')
      console.error('[WebSocket] Failed to create WebSocket:', error)
    }
  }, [url])

  const disconnect = useCallback(() => {
    // Clear keep-alive ping interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setConnectionState('closed')
  }, [])

  const sendMessage = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    } else {
      console.warn('WebSocket not connected, cannot send message:', message)
    }
  }, [])

  const addMessageHandler = useCallback((handler) => {
    messageHandlersRef.current.add(handler)
    return () => messageHandlersRef.current.delete(handler)
  }, [])

  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return {
    connectionState,
    connect,
    disconnect,
    sendMessage,
    addMessageHandler
  }
}
