/**
 * Device detection utility
 * Detects mobile devices and checks for system audio capture support
 */

/**
 * Checks if the current device is a mobile device
 * @returns {boolean} true if the device is mobile
 */
export function isMobileDevice() {
  if (typeof window === 'undefined') return false
  
  const userAgent = navigator.userAgent || navigator.vendor || window.opera
  
  // Check for common mobile device patterns
  const mobilePatterns = [
    /Android/i,
    /webOS/i,
    /iPhone/i,
    /iPad/i,
    /iPod/i,
    /BlackBerry/i,
    /Windows Phone/i,
    /Mobile/i
  ]
  
  // Check user agent
  if (mobilePatterns.some(pattern => pattern.test(userAgent))) {
    return true
  }
  
  // Check for touch screen (additional indicator for mobile)
  const hasTouchScreen = 'ontouchstart' in window || 
                         navigator.maxTouchPoints > 0 || 
                         navigator.msMaxTouchPoints > 0
  
  // Check screen size (mobile devices typically have smaller screens)
  const isSmallScreen = window.innerWidth <= 768
  
  // Consider it mobile if it has touch screen and small screen
  return hasTouchScreen && isSmallScreen
}

/**
 * Checks if system audio capture is supported
 * System audio capture requires getDisplayMedia API which is not available on mobile
 * @returns {boolean} true if system audio capture is supported
 */
export function isSystemAudioSupported() {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.mediaDevices === 'undefined') return false
  if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') return false
  
  // Mobile devices don't support system audio capture
  if (isMobileDevice()) {
    return false
  }
  
  // Check if browser supports getDisplayMedia
  return true
}

